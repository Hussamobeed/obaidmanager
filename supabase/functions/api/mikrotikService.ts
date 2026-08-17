import { connectRouterOS } from "./mikrotikClient.ts";
import { decrypt } from "./cryptoService.ts";
import { API_VERSION } from "./version.ts";

export interface RouterRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
  ssl_enabled: boolean;
}

async function withConnection<T>(
  router: RouterRow,
  fn: (conn: Awaited<ReturnType<typeof connectRouterOS>>) => Promise<T>
): Promise<T> {
  const password = await decrypt(router.password_encrypted);
  let conn: Awaited<ReturnType<typeof connectRouterOS>>;
  try {
    conn = await connectRouterOS({
      host: router.host,
      port: router.port,
      username: router.username,
      password,
      ssl: router.ssl_enabled,
    });
  } catch (err) {
    throw new Error(`[v${API_VERSION}] تعذّر تسجيل الدخول إلى الراوتر "${router.name}": ${(err as Error).message}`);
  }
  try {
    return await fn(conn);
  } catch (err) {
    throw new Error(`[v${API_VERSION}] فشلت عملية RouterOS على الراوتر "${router.name}": ${(err as Error).message}`);
  } finally {
    conn.close();
  }
}

export async function testConnection(router: RouterRow) {
  return withConnection(router, async (conn) => {
    const identity = await conn.command(["/system/identity/print"]);
    const resource = await conn.command(["/system/resource/print"]);
    return {
      identity: identity[0]?.name ?? "unknown",
      routerosVersion: resource[0]?.version ?? "unknown",
    };
  });
}

export async function synchronizeProfilesAndCustomers(router: RouterRow) {
  return withConnection(router, async (conn) => {
    const safe = async (words: string[]) => {
      try {
        return await conn.command(words);
      } catch {
        return [] as Record<string, string>[];
      }
    };

    // This one-time import deliberately excludes User Manager users and
    // sessions, which can grow very large and exceed the Edge Function limit.
    const customersRows = await safe(["/tool/user-manager/customer/print"]);
    const profilesRows = await safe(["/tool/user-manager/profile/print"]);

    return {
      customers: customersRows
        .map((customer) => ({ name: customer.login ?? customer.name ?? "" }))
        .filter((customer) => customer.name.trim().length > 0),
      profiles: profilesRows
        .map((profile) => ({ name: profile.name ?? "" }))
        .filter((profile) => profile.name.trim().length > 0),
      syncedAt: new Date().toISOString(),
    };
  });
}

// RouterOS 6.49.x can close the API connection when `source` contains a
// large card batch. Keep each script source deliberately below this ceiling.
// A generated card script is line-oriented, and every user command remains
// complete because a chunk boundary is only inserted between lines.
const ROUTEROS6_MAX_SOURCE_BYTES = 2_400;

function splitSourceForRouterOS6(scriptContent: string): string[] {
  const encoder = new TextEncoder();
  const runDateLine = ":local scriptRunDate [/system clock get date];\n";
  const lines = scriptContent.replace(/\r\n/g, "\n").split("\n");
  const chunks: string[] = [];
  let current = runDateLine;

  for (const line of lines) {
    // The generator already includes this declaration once. Each temporary
    // chunk needs its own local variable because it runs as a separate script.
    if (/^\s*:local\s+scriptRunDate\s+\[\/system clock get date\];?\s*$/.test(line)) continue;
    const statement = `${line}\n`;
    if (encoder.encode(runDateLine + statement).length > ROUTEROS6_MAX_SOURCE_BYTES) {
      throw new Error("أحد أسطر السكربت أكبر من الحد الآمن لراوتر RouterOS 6");
    }
    if (encoder.encode(current + statement).length > ROUTEROS6_MAX_SOURCE_BYTES && current !== runDateLine) {
      chunks.push(current);
      current = runDateLine;
    }
    current += statement;
  }
  if (current !== runDateLine) chunks.push(current);
  if (!chunks.length) throw new Error("محتوى السكربت فارغ");
  return chunks;
}

export async function exportScriptToRouter(
  router: RouterRow,
  fileName: string,
  scriptContent: string
) {
  return withConnection(router, async (conn) => {
    const log: string[] = [`[Edge Function version: ${API_VERSION}]`];
    const sanitized = fileName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
    const sources = splitSourceForRouterOS6(scriptContent);
    log.push(`تقسيم السكربت إلى ${sources.length} جزءًا صغيرًا متوافقًا مع RouterOS 6...`);

    for (let index = 0; index < sources.length; index++) {
      const scriptName = `obaidmgr_${sanitized}_${Date.now()}_${index + 1}`;
      const source = sources[index];
      log.push(`إنشاء وتنفيذ الجزء ${index + 1}/${sources.length}...`);
      // No policy argument is sent. RouterOS applies the configured account's
      // existing API/Winbox permissions.
      await conn.command(["/system/script/add", `=name=${scriptName}`, `=source=${source}`]);

      // The user's RouterOS 6.49.11 accepts `number` with the script name for
      // small scripts. Sending only small parts avoids the large-source socket
      // closure while preserving the temporary script workflow.
      const scripts = await conn.command([
        "/system/script/print",
        `?=name=${scriptName}`,
        "=.proplist=.id,name",
      ]);
      const scriptId = scripts[0]?.[".id"];
      if (!scriptId) throw new Error(`تعذّر العثور على جزء السكربت ${index + 1} بعد إنشائه`);

      try {
        await conn.command(["/system/script/run", `=number=${scriptName}`]);
      } finally {
        try {
          await conn.command(["/system/script/remove", `=.id=${scriptId}`]);
        } catch {
          log.push(`تعذّر حذف الجزء المؤقت ${index + 1} تلقائيًا.`);
        }
      }
    }

    log.push(`تم تنفيذ ${sources.length} جزءًا وحذف السكربتات المؤقتة.`);
    return { success: true, log };
  });
}
