import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { sha256 } from "../_shared/security.ts";

const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const invalidDevice = () => Response.json({ error: "Invalid device token" }, { status: 401, headers: corsHeaders });
const sessionFields = ["nas_port", "nas_port_id", "calling_station_id", "called_station_id", "last_seen", "bytes_in", "bytes_out", "uptime"];

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return invalidDevice();
    const client = db();
    const { data: device } = await client.from("sync_devices").select("id,router_id,owner_id,revoked_at").eq("token_hash", await sha256(token)).maybeSingle();
    if (!device || device.revoked_at) return invalidDevice();
    const body = await request.json();

    if (body.action === "start") {
      const mode = body.mode === "bootstrap" ? "bootstrap" : "incremental";
      const { data: run, error } = await client.from("sync_runs").insert({ router_id: device.router_id, owner_id: device.owner_id, device_id: device.id, mode, status: "running" }).select("id").single();
      if (error) throw error;
      if (mode === "incremental") {
        const { error: copyError } = await client.rpc("copy_latest_report_users", { p_router_id: device.router_id, p_new_run_id: run.id });
        if (copyError) throw copyError;
      }
      await client.from("sync_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", device.id);
      return Response.json({ run_id: run.id }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const runId = body.run_id as string;
    const { data: run } = await client.from("sync_runs").select("id,status,router_id").eq("id", runId).eq("router_id", device.router_id).maybeSingle();
    if (!run || run.status !== "running") return Response.json({ error: "Run is not writable" }, { status: 409, headers: corsHeaders });

    if (body.action === "chunk") {
      let users: Record<string, unknown>[] = Array.isArray(body.users) ? body.users.map((row: Record<string, unknown>) => ({ ...row, router_id: device.router_id, run_id: runId })) : [];
      const profiles: Record<string, unknown>[] = Array.isArray(body.profiles) ? body.profiles.map((row: Record<string, unknown>) => ({ ...row, router_id: device.router_id, run_id: runId })) : [];
      if (body.preserve_session_fields && users.length) {
        const usernames = users.map((row) => String(row.username ?? "")).filter(Boolean);
        const { data: previous, error: previousError } = await client.from("report_users").select("username,nas_port,nas_port_id,calling_station_id,called_station_id,last_seen,bytes_in,bytes_out,uptime").eq("run_id", runId).in("username", usernames);
        if (previousError) throw previousError;
        const previousByUser = new Map((previous ?? []).map((row) => [row.username, row]));
        users = users.map((row) => {
          const old = previousByUser.get(String(row.username ?? ""));
          if (!old) return row;
          const merged = { ...row };
          for (const field of sessionFields) if (!merged[field]) merged[field] = old[field as keyof typeof old];
          return merged;
        });
      }
      if (users.length) { const { error } = await client.from("report_users").upsert(users, { onConflict: "run_id,username" }); if (error) throw error; }
      if (profiles.length) { const { error } = await client.from("report_profiles").insert(profiles); if (error) throw error; }
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (body.action === "finish") {
      const counts = body.counts ?? {};
      const { error: runError } = await client.from("sync_runs").update({ status: "success", users_count: counts.users ?? 0, profiles_count: counts.profiles ?? 0, session_rows_count: counts.sessions ?? 0, message: body.message ?? null, finished_at: new Date().toISOString() }).eq("id", runId);
      if (runError) throw runError;
      const { error: snapshotError } = await client.from("report_snapshots").upsert({ router_id: device.router_id, owner_id: device.owner_id, active_run_id: runId, updated_at: new Date().toISOString() });
      if (snapshotError) throw snapshotError;
      return Response.json({ ok: true }, { headers: corsHeaders });
    }
    if (body.action === "fail") { await client.from("sync_runs").update({ status: "error", message: String(body.message ?? "Worker failed"), finished_at: new Date().toISOString() }).eq("id", runId); return Response.json({ ok: true }, { headers: corsHeaders }); }
    return Response.json({ error: "Unknown action" }, { status: 400, headers: corsHeaders });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 400, headers: corsHeaders }); }
});
