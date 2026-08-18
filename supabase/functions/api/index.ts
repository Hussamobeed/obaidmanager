import { Hono } from "jsr:@hono/hono@4";
import { z } from "npm:zod@3.23.8";
import { LIBRARY_BUCKET, supabase } from "./db.ts";
import { ensureLibraryBucket } from "./storage.ts";
import { encrypt } from "./cryptoService.ts";
import {
  exportScriptToRouter,
  synchronizeProfilesAndCustomers,
  testConnection,
  type RouterRow,
} from "./mikrotikService.ts";
import { API_VERSION } from "./version.ts";
import {
  detectRouterMode,
  fetchUserManagerReportDay,
  syncUserManagerCatalog,
} from "./sabaUserManagerService.ts";

type Vars = { userId: string };
const app = new Hono<{ Variables: Vars }>().basePath("/api");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return c.text("ok", 200, corsHeaders);
  await next();
  Object.entries(corsHeaders).forEach(([k, v]) => c.res.headers.set(k, v));
});

function fail(c: any, status: number, message: string, code = "ERROR") {
  return c.json({ error: { code, message } }, status);
}

// ---------------------------------------------------------------- health --
// (No auth required — simple liveness check.)
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "saba-manager-api",
    version: API_VERSION,
    timestamp: new Date().toISOString(),
  })
);

// ---------------------------------------------------------- auth gate ----
// Every route below requires a real logged-in Supabase user (not just the
// anon key). The frontend sends the user's session access token as the
// Authorization header once they've signed in.
app.use("/*", async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return fail(c, 401, "الرجاء تسجيل الدخول أولًا", "UNAUTHENTICATED");
  }
  c.set("userId", data.user.id);
  await next();
});

// -------------------------------------------------------------- routers --
const routerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(8729),
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(255),
  sslEnabled: z.boolean().default(true),
  description: z.string().max(500).optional(),
  isDefault: z.boolean().default(false),
});

function toPublicRouter(r: any) {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    sslEnabled: r.ssl_enabled,
    description: r.description,
    isDefault: r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

app.get("/routers", async (c) => {
  const userId = c.get("userId");
  const { data, error } = await supabase
    .from("routers")
    .select("*")
    .eq("owner_id", userId)
    .order("created_at", { ascending: false });
  if (error) return fail(c, 500, error.message);
  return c.json({ data: (data ?? []).map(toPublicRouter) });
});

app.post("/routers", async (c) => {
  const userId = c.get("userId");
  const parsed = routerSchema.safeParse(await c.req.json());
  if (!parsed.success) return fail(c, 400, "بيانات غير صالحة", "VALIDATION_ERROR");
  const input = parsed.data;

  if (input.isDefault) {
    await supabase.from("routers").update({ is_default: false }).eq("owner_id", userId);
  }

  const { data, error } = await supabase
    .from("routers")
    .insert({
      owner_id: userId,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      password_encrypted: await encrypt(input.password),
      ssl_enabled: input.sslEnabled,
      description: input.description ?? null,
      is_default: input.isDefault,
    })
    .select()
    .single();

  if (error) return fail(c, 500, error.message);
  return c.json({ data: toPublicRouter(data) }, 201);
});

app.put("/routers/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const parsed = routerSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return fail(c, 400, "بيانات غير صالحة", "VALIDATION_ERROR");
  const input = parsed.data;

  if (input.isDefault) {
    await supabase.from("routers").update({ is_default: false }).eq("owner_id", userId);
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) update.name = input.name;
  if (input.host !== undefined) update.host = input.host;
  if (input.port !== undefined) update.port = input.port;
  if (input.username !== undefined) update.username = input.username;
  if (input.password) update.password_encrypted = await encrypt(input.password);
  if (input.sslEnabled !== undefined) update.ssl_enabled = input.sslEnabled;
  if (input.description !== undefined) update.description = input.description;
  if (input.isDefault !== undefined) update.is_default = input.isDefault;

  const { data, error } = await supabase
    .from("routers")
    .update(update)
    .eq("id", id)
    .eq("owner_id", userId)
    .select()
    .single();
  if (error) return fail(c, 500, error.message);
  return c.json({ data: toPublicRouter(data) });
});

app.delete("/routers/:id", async (c) => {
  const userId = c.get("userId");
  const { error } = await supabase.from("routers").delete().eq("id", c.req.param("id")).eq("owner_id", userId);
  if (error) return fail(c, 500, error.message);
  return c.body(null, 204);
});

async function getRouterRow(id: string, userId: string): Promise<RouterRow | null> {
  const { data } = await supabase.from("routers").select("*").eq("id", id).eq("owner_id", userId).single();
  return (data as RouterRow) ?? null;
}

app.post("/routers/:id/test-connection", async (c) => {
  const router = await getRouterRow(c.req.param("id"), c.get("userId"));
  if (!router) return fail(c, 404, "الراوتر غير موجود", "ROUTER_NOT_FOUND");
  try {
    const result = await testConnection(router);
    return c.json({ data: { connected: true, ...result } });
  } catch (err) {
    return fail(c, 502, (err as Error).message, "MIKROTIK_CONNECTION_FAILED");
  }
});

// ----------------------------------------------------------------- sync --
// A manual sync stores only the current User Manager customers and profiles.
// Individual users and session records are intentionally never requested,
// persisted, or returned by this application.
app.post("/sync/:routerId", async (c) => {
  const userId = c.get("userId");
  const routerId = c.req.param("routerId");
  const router = await getRouterRow(routerId, userId);
  if (!router) return fail(c, 404, "الراوتر غير موجود", "ROUTER_NOT_FOUND");

  try {
    const result = await synchronizeProfilesAndCustomers(router);
    const profiles = result.profiles.map((profile) => ({ name: profile.name }));

    const { error } = await supabase.from("router_sync_snapshots").upsert({
      router_id: routerId,
      owner_id: userId,
      customers: result.customers,
      profiles,
      updated_at: result.syncedAt,
    });
    if (error) throw error;

    return c.json({
      data: {
        routerId,
        customers: result.customers,
        profiles: result.profiles,
        syncedAt: result.syncedAt,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "تعذّرت مزامنة الراوتر";
    return fail(c, 502, message, "SYNC_FAILED");
  }
});

app.get("/sync/:routerId/cache", async (c) => {
  const userId = c.get("userId");
  const routerId = c.req.param("routerId");
  const { data: snapshot, error } = await supabase
    .from("router_sync_snapshots")
    .select("customers,profiles,updated_at")
    .eq("router_id", routerId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (error) return fail(c, 500, error.message);
  if (!snapshot) return c.json({ data: null });
  return c.json({
    data: {
      customers: snapshot.customers ?? [],
      profiles: snapshot.profiles ?? [],
      last_synced_at: snapshot.updated_at,
    },
  });
});

// ------------------------------------------------------ export-to-mikrotik --
const exportSchema = z.object({
  routerId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  scriptContent: z.string().min(1).optional(),
  libraryFileId: z.string().uuid().optional(),
  progressId: z.string().uuid().optional(),
});

type ExportProgress = {
  current: number;
  total: number;
  phase: "preparing" | "running" | "completed";
};

app.post("/export-to-mikrotik", async (c) => {
  const userId = c.get("userId");
  const parsed = exportSchema.safeParse(await c.req.json());
  if (!parsed.success) return fail(c, 400, "بيانات غير صالحة", "VALIDATION_ERROR");
  const input = parsed.data;

  const router = await getRouterRow(input.routerId, userId);
  if (!router) return fail(c, 404, "الراوتر غير موجود", "ROUTER_NOT_FOUND");

  try {
    await ensureLibraryBucket();
  } catch (err) {
    return fail(c, 500, err instanceof Error ? err.message : "تعذّر تجهيز حاوية المكتبة", "STORAGE_UNAVAILABLE");
  }

  let progressRecordId: string | null = null;
  if (input.progressId) {
    const { data, error } = await supabase
      .from("export_history")
      .insert({
        user_id: userId,
        router_id: router.id,
        library_file_id: input.libraryFileId ?? null,
        status: "running",
        message: JSON.stringify({ progress_id: input.progressId, current: 0, total: 0, phase: "preparing" }),
      })
      .select("id")
      .single();
    if (error || !data) return fail(c, 500, error?.message ?? "تعذّر بدء متابعة التصدير");
    progressRecordId = data.id;
  }

  const updateProgress = async (progress: ExportProgress) => {
    if (!progressRecordId || !input.progressId) return;
    const { error } = await supabase
      .from("export_history")
      .update({
        status: progress.phase === "completed" ? "success" : "running",
        message: JSON.stringify({ progress_id: input.progressId, ...progress }),
      })
      .eq("id", progressRecordId)
      .eq("user_id", userId);
    if (error) console.error("Unable to update export progress", error);
  };

  let scriptContent = input.scriptContent;
  if (!scriptContent && input.libraryFileId) {
    const { data: fileRow } = await supabase
      .from("library_files")
      .select("*")
      .eq("id", input.libraryFileId)
      .eq("user_id", userId)
      .single();
    if (!fileRow) return fail(c, 404, "الملف غير موجود في المكتبة", "FILE_NOT_FOUND");
    const { data: blob, error } = await supabase.storage.from(LIBRARY_BUCKET).download(fileRow.storage_path);
    if (error || !blob) return fail(c, 500, "تعذّر قراءة الملف من المكتبة");
    scriptContent = await blob.text();
  }
  if (!scriptContent) return fail(c, 400, "لا يوجد محتوى سكريبت للتصدير", "MISSING_SCRIPT");

  try {
    const result = await exportScriptToRouter(router, input.fileName, scriptContent, updateProgress);
    if (progressRecordId) {
      await supabase
        .from("export_history")
        .update({ status: "success", message: result.log.join(" | ") })
        .eq("id", progressRecordId)
        .eq("user_id", userId);
    } else {
      await supabase.from("export_history").insert({
        user_id: userId,
        router_id: router.id,
        library_file_id: input.libraryFileId ?? null,
        status: "success",
        message: result.log.join(" | "),
      });
    }
    return c.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "فشل تصدير السكريبت";
    if (progressRecordId) {
      await supabase
        .from("export_history")
        .update({ status: "error", message })
        .eq("id", progressRecordId)
        .eq("user_id", userId);
    } else {
      await supabase.from("export_history").insert({
        user_id: userId,
        router_id: router.id,
        library_file_id: input.libraryFileId ?? null,
        status: "error",
        message,
      });
    }
    return fail(c, 502, message, "EXPORT_FAILED");
  }
});

app.get("/export-to-mikrotik/progress/:progressId", async (c) => {
  const { data: rows, error } = await supabase
    .from("export_history")
    .select("status,message")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) return fail(c, 500, error.message);

  const progressId = c.req.param("progressId");
  for (const row of rows ?? []) {
    try {
      const progress = JSON.parse(row.message ?? "{}") as Record<string, unknown>;
      if (progress.progress_id !== progressId) continue;
      return c.json({
        data: {
          status: row.status,
          current: Number(progress.current ?? 0),
          total: Number(progress.total ?? 0),
          phase: progress.phase ?? "preparing",
        },
      });
    } catch {
      // Completed and legacy history rows contain a plain-text message.
    }
  }

  return c.json({ data: null });
});

app.get("/export-to-mikrotik/history", async (c) => {
  const { data } = await supabase
    .from("export_history")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: false })
    .limit(100);
  return c.json({ data: data ?? [] });
});

// ------------------------------------------------------------- library --
app.get("/library", async (c) => {
  const { data, error } = await supabase
    .from("library_files")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: false });
  if (error) return fail(c, 500, error.message);
  return c.json({ data: data ?? [] });
});

app.post("/library", async (c) => {
  const userId = c.get("userId");
  try {
    await ensureLibraryBucket();
  } catch (err) {
    return fail(c, 500, err instanceof Error ? err.message : "تعذّر تجهيز حاوية المكتبة", "STORAGE_UNAVAILABLE");
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail(c, 400, "لم يتم إرفاق أي ملف", "MISSING_FILE");

  const name = String(form.get("name") ?? file.name);
  const fileType = String(form.get("fileType") ?? "txt");
  const customer = form.get("customer") ? String(form.get("customer")) : null;
  const profile = form.get("profile") ? String(form.get("profile")) : null;
  const prefix = form.get("prefix") ? String(form.get("prefix")) : null;
  const numberCount = form.get("numberCount") ? Number(form.get("numberCount")) : null;

  const storagePath = `${userId}/${crypto.randomUUID()}_${name}`.replace(/\s+/g, "_");
  const { error: uploadError } = await supabase.storage
    .from(LIBRARY_BUCKET)
    .upload(storagePath, file, { contentType: file.type || "application/octet-stream" });
  if (uploadError) return fail(c, 500, uploadError.message);

  const { data, error } = await supabase
    .from("library_files")
    .insert({
      user_id: userId,
      name,
      file_type: fileType,
      storage_path: storagePath,
      customer,
      profile,
      prefix,
      number_count: numberCount,
    })
    .select()
    .single();

  if (error) return fail(c, 500, error.message);
  return c.json({ data }, 201);
});

app.get("/library/:id/download", async (c) => {
  const userId = c.get("userId");
  const { data: fileRow } = await supabase
    .from("library_files")
    .select("*")
    .eq("id", c.req.param("id"))
    .eq("user_id", userId)
    .single();
  if (!fileRow) return fail(c, 404, "الملف غير موجود", "FILE_NOT_FOUND");

  const { data: blob, error } = await supabase.storage.from(LIBRARY_BUCKET).download(fileRow.storage_path);
  if (error || !blob) return fail(c, 500, "تعذّر تنزيل الملف");
  return new Response(blob, {
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileRow.name}"`,
    },
  });
});

app.patch("/library/:id", async (c) => {
  const { name } = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  const { data, error } = await supabase
    .from("library_files")
    .update({ name })
    .eq("id", c.req.param("id"))
    .eq("user_id", c.get("userId"))
    .select()
    .single();
  if (error) return fail(c, 500, error.message);
  return c.json({ data });
});

app.post("/library/:id/duplicate", async (c) => {
  const userId = c.get("userId");
  const { data: fileRow } = await supabase
    .from("library_files")
    .select("*")
    .eq("id", c.req.param("id"))
    .eq("user_id", userId)
    .single();
  if (!fileRow) return fail(c, 404, "الملف غير موجود", "FILE_NOT_FOUND");

  const newPath = `${userId}/${crypto.randomUUID()}_${fileRow.name}`.replace(/\s+/g, "_");
  const { error: copyError } = await supabase.storage.from(LIBRARY_BUCKET).copy(fileRow.storage_path, newPath);
  if (copyError) return fail(c, 500, copyError.message);

  const { data, error } = await supabase
    .from("library_files")
    .insert({
      user_id: userId,
      name: `نسخة من ${fileRow.name}`,
      file_type: fileRow.file_type,
      storage_path: newPath,
      customer: fileRow.customer,
      profile: fileRow.profile,
      prefix: fileRow.prefix,
      number_count: fileRow.number_count,
    })
    .select()
    .single();

  if (error) return fail(c, 500, error.message);
  return c.json({ data }, 201);
});

app.delete("/library/:id", async (c) => {
  const userId = c.get("userId");
  const { data: fileRow } = await supabase
    .from("library_files")
    .select("*")
    .eq("id", c.req.param("id"))
    .eq("user_id", userId)
    .single();
  if (fileRow) await supabase.storage.from(LIBRARY_BUCKET).remove([fileRow.storage_path]);
  await supabase.from("library_files").delete().eq("id", c.req.param("id")).eq("user_id", userId);
  return c.body(null, 204);
});

// ------------------------------------------------------------- settings --
app.get("/settings", async (c) => {
  const { data } = await supabase.from("app_settings").select("key, value").eq("user_id", c.get("userId"));
  const settings: Record<string, unknown> = {};
  for (const row of data ?? []) settings[row.key] = row.value;
  return c.json({ data: settings });
});

app.put("/settings/:key", async (c) => {
  const value = await c.req.json();
  const { error } = await supabase
    .from("app_settings")
    .upsert({ user_id: c.get("userId"), key: c.req.param("key"), value, updated_at: new Date().toISOString() });
  if (error) return fail(c, 500, error.message);
  return c.json({ data: value });
});

app.get("/settings/export/json", async (c) => {
  const userId = c.get("userId");
  const { data: settingsRows } = await supabase.from("app_settings").select("key, value").eq("user_id", userId);
  const { data: presets } = await supabase.from("presets").select("*").eq("user_id", userId);
  const settings: Record<string, unknown> = {};
  for (const row of settingsRows ?? []) settings[row.key] = row.value;
  return c.json({ settings, presets: presets ?? [], exportedAt: new Date().toISOString() });
});

app.post("/settings/import/json", async (c) => {
  const userId = c.get("userId");
  const body = z
    .object({
      settings: z.record(z.unknown()).default({}),
      presets: z.array(z.object({ name: z.string(), settings_json: z.unknown() })).default([]),
    })
    .parse(await c.req.json());

  for (const [key, value] of Object.entries(body.settings)) {
    await supabase.from("app_settings").upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() });
  }
  return c.json({ data: { imported: true } });
});

app.get("/settings/presets/all", async (c) => {
  const { data } = await supabase
    .from("presets")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: false });
  return c.json({ data: data ?? [] });
});

app.post("/settings/presets/all", async (c) => {
  const userId = c.get("userId");
  const body = z.object({ name: z.string().min(1), settings: z.record(z.unknown()) }).parse(await c.req.json());
  const { data, error } = await supabase
    .from("presets")
    .insert({ user_id: userId, name: body.name, settings: body.settings })
    .select()
    .single();
  if (error) return fail(c, 500, error.message);
  return c.json({ data }, 201);
});

app.delete("/settings/presets/all/:id", async (c) => {
  await supabase.from("presets").delete().eq("id", c.req.param("id")).eq("user_id", c.get("userId"));
  return c.body(null, 204);
});

// ------------------------------------------------------------- templates --
// Per-profile print templates: each optionally links to a MikroTik User
// Manager profile name so the frontend can auto-apply the right layout when
// that profile is selected in the generator.
const templateSchema = z.object({
  name: z.string().min(1).max(100),
  profile: z.string().max(100).nullable().optional(),
  layout: z.record(z.unknown()),
});

app.get("/templates", async (c) => {
  const { data, error } = await supabase
    .from("templates")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: false });
  if (error) return fail(c, 500, error.message);
  return c.json({ data: data ?? [] });
});

app.post("/templates", async (c) => {
  const userId = c.get("userId");
  const parsed = templateSchema.safeParse(await c.req.json());
  if (!parsed.success) return fail(c, 400, "بيانات غير صالحة", "VALIDATION_ERROR");
  const input = parsed.data;
  const { data, error } = await supabase
    .from("templates")
    .insert({ user_id: userId, name: input.name, profile: input.profile ?? null, layout: input.layout })
    .select()
    .single();
  if (error) return fail(c, 500, error.message);
  return c.json({ data }, 201);
});

app.put("/templates/:id", async (c) => {
  const userId = c.get("userId");
  const parsed = templateSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return fail(c, 400, "بيانات غير صالحة", "VALIDATION_ERROR");
  const input = parsed.data;
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) update.name = input.name;
  if (input.profile !== undefined) update.profile = input.profile;
  if (input.layout !== undefined) update.layout = input.layout;

  const { data, error } = await supabase
    .from("templates")
    .update(update)
    .eq("id", c.req.param("id"))
    .eq("user_id", userId)
    .select()
    .single();
  if (error) return fail(c, 500, error.message);
  return c.json({ data });
});

app.delete("/templates/:id", async (c) => {
  await supabase.from("templates").delete().eq("id", c.req.param("id")).eq("user_id", c.get("userId"));
  return c.body(null, 204);
});

// ------------------------------------------------ SABA cloud catalogue --
app.post("/saba/catalog/:routerId/sync", async (c) => {
  const userId = c.get("userId");
  const routerId = c.req.param("routerId");
  const router = await getRouterRow(routerId, userId);
  if (!router) return fail(c, 404, "الراوتر غير موجود", "ROUTER_NOT_FOUND");
  try {
    const mode = await detectRouterMode(router);
    const catalog = await syncUserManagerCatalog(router, mode);
    const { error } = await supabase.from("um_catalogs").upsert({
      router_id: routerId,
      owner_id: userId,
      router_version: mode.version,
      profiles: catalog.profiles,
      customers: catalog.customers,
      synced_at: catalog.syncedAt,
    });
    if (error) throw error;
    await supabase.from("routers").update({
      routeros_version: mode.version,
      board_name: mode.boardName,
      last_connected_at: new Date().toISOString(),
    }).eq("id", routerId).eq("owner_id", userId);
    return c.json({ data: { ...catalog, router: mode } });
  } catch (err) {
    return fail(c, 502, err instanceof Error ? err.message : "تعذرت مزامنة كتالوج User Manager", "CATALOG_SYNC_FAILED");
  }
});

app.get("/saba/catalog/:routerId", async (c) => {
  const { data, error } = await supabase
    .from("um_catalogs")
    .select("router_version,profiles,customers,synced_at")
    .eq("router_id", c.req.param("routerId"))
    .eq("owner_id", c.get("userId"))
    .maybeSingle();
  if (error) return fail(c, 500, error.message);
  return c.json({ data: data ?? null });
});

// -------------------------------------------- resumable report jobs -------
const reportJobSchema = z.object({
  routerId: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function nextIsoDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

app.post("/saba/reports/userman", async (c) => {
  const userId = c.get("userId");
  const parsed = reportJobSchema.safeParse(await c.req.json());
  if (!parsed.success) return fail(c, 400, "يجب تحديد تاريخ بداية ونهاية صالحين", "VALIDATION_ERROR");
  const input = parsed.data;
  if (input.from > input.to) return fail(c, 400, "تاريخ البداية يجب أن يسبق تاريخ النهاية", "VALIDATION_ERROR");
  const router = await getRouterRow(input.routerId, userId);
  if (!router) return fail(c, 404, "الراوتر غير موجود", "ROUTER_NOT_FOUND");
  const { data, error } = await supabase.from("report_jobs").insert({
    owner_id: userId,
    router_id: input.routerId,
    report_type: "userman-report",
    date_from: input.from,
    date_to: input.to,
    status: "queued",
    cursor: { next_date: input.from },
  }).select().single();
  if (error || !data) return fail(c, 500, error?.message ?? "تعذّر بدء التقرير");
  return c.json({ data }, 201);
});

app.post("/saba/reports/:id/continue", async (c) => {
  const userId = c.get("userId");
  const { data: job, error: jobError } = await supabase
    .from("report_jobs")
    .select("*")
    .eq("id", c.req.param("id"))
    .eq("owner_id", userId)
    .eq("report_type", "userman-report")
    .single();
  if (jobError || !job) return fail(c, 404, "مهمة التقرير غير موجودة", "REPORT_JOB_NOT_FOUND");
  if (job.status === "completed") return c.json({ data: job });
  const router = await getRouterRow(job.router_id, userId);
  if (!router) return fail(c, 404, "الراوتر غير موجود", "ROUTER_NOT_FOUND");
  const currentDate = String(job.cursor?.next_date ?? job.date_from);
  if (!currentDate || currentDate > String(job.date_to)) {
    const { data: completed } = await supabase.from("report_jobs").update({
      status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("owner_id", userId).select().single();
    return c.json({ data: completed });
  }
  try {
    const mode = await detectRouterMode(router);
    const rows = await fetchUserManagerReportDay(router, mode, currentDate);
    const startNumber = Number(job.processed_rows ?? 0);
    if (rows.length) {
      const payload = rows.map((row, index) => ({
        job_id: job.id,
        owner_id: userId,
        row_number: startNumber + index + 1,
        identity_key: row.username,
        row_data: row,
      }));
      const { error } = await supabase.from("report_rows").upsert(payload, {
        onConflict: "job_id,identity_key",
        ignoreDuplicates: true,
      });
      if (error) throw error;
    }
    const nextDate = nextIsoDate(currentDate);
    const isComplete = nextDate > String(job.date_to);
    const { data: updated, error: updateError } = await supabase.from("report_jobs").update({
      status: isComplete ? "completed" : "running",
      cursor: { next_date: nextDate },
      processed_rows: startNumber + rows.length,
      updated_at: new Date().toISOString(),
      completed_at: isComplete ? new Date().toISOString() : null,
      error_message: null,
    }).eq("id", job.id).eq("owner_id", userId).select().single();
    if (updateError) throw updateError;
    return c.json({ data: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "فشل جلب جزء التقرير";
    await supabase.from("report_jobs").update({
      status: "failed", error_message: message, updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("owner_id", userId);
    return fail(c, 502, message, "REPORT_SLICE_FAILED");
  }
});

app.get("/saba/reports/:id", async (c) => {
  const { data, error } = await supabase.from("report_jobs").select("*")
    .eq("id", c.req.param("id")).eq("owner_id", c.get("userId")).single();
  if (error || !data) return fail(c, 404, "مهمة التقرير غير موجودة", "REPORT_JOB_NOT_FOUND");
  return c.json({ data });
});

app.get("/saba/reports/:id/rows", async (c) => {
  const userId = c.get("userId");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(c.req.query("pageSize") ?? 50)));
  const from = (page - 1) * pageSize;
  const { data, error, count } = await supabase.from("report_rows")
    .select("row_number,row_data", { count: "exact" })
    .eq("job_id", c.req.param("id")).eq("owner_id", userId)
    .order("row_number", { ascending: true }).range(from, from + pageSize - 1);
  if (error) return fail(c, 500, error.message);
  return c.json({ data: data ?? [], page, pageSize, total: count ?? 0 });
});

Deno.serve(app.fetch);
