import { decrypt } from "./cryptoService.ts";
import { connectRouterOS, type RouterOSConnection } from "./mikrotikClient.ts";
import type { RouterRow } from "./mikrotikService.ts";

export type RouterMode = {
  majorVersion: 6 | 7;
  version: string;
  identity: string;
  boardName: string;
};

export type UserManagerReportRow = {
  firstLoginDate: string;
  username: string;
  price: string;
  profile: string;
  nasPortId: string;
};

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function value(row: Record<string, string>, key: string, fallback = ""): string {
  return row[key] ?? fallback;
}

function toRouterDate(isoDate: string, endOfDay = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error("صيغة تاريخ التقرير غير صالحة");
  const [, year, month, day] = match;
  return `${months[Number(month) - 1]}/${day}/${year} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function parseRouterTime(valueToParse: string): number {
  const text = String(valueToParse ?? "").trim().toLowerCase();
  const matched = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/.exec(text);
  if (!matched) return Number.POSITIVE_INFINITY;
  const [, month, day, year, hour = "0", minute = "0", second = "0"] = matched;
  return Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second));
}

async function withConnection<T>(router: RouterRow, fn: (conn: RouterOSConnection) => Promise<T>): Promise<T> {
  const password = await decrypt(router.password_encrypted);
  const conn = await connectRouterOS({
    host: router.host,
    port: router.port,
    username: router.username,
    password,
    ssl: router.ssl_enabled,
  });
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

export async function detectRouterMode(router: RouterRow): Promise<RouterMode> {
  return withConnection(router, async (conn) => {
    const [identityRows, resourceRows] = await Promise.all([
      conn.command(["/system/identity/print", "=.proplist=name"]),
      conn.command(["/system/resource/print", "=.proplist=version,board-name"]),
    ]);
    const version = value(resourceRows[0] ?? {}, "version", "7");
    const major = Number.parseInt(version, 10) === 6 ? 6 : 7;
    return {
      majorVersion: major,
      version,
      identity: value(identityRows[0] ?? {}, "name", "MikroTik"),
      boardName: value(resourceRows[0] ?? {}, "board-name"),
    };
  });
}

export async function syncUserManagerCatalog(router: RouterRow, mode: RouterMode) {
  return withConnection(router, async (conn) => {
    const base = mode.majorVersion === 6 ? "/tool/user-manager" : "/user-manager";
    const safe = async (words: string[]) => {
      try { return await conn.command(words); } catch { return [] as Record<string, string>[]; }
    };
    const [customers, profiles] = await Promise.all([
      safe([`${base}/customer/print`, "=.proplist=name,login"]),
      safe([`${base}/profile/print`, "=.proplist=name,price,validity"]),
    ]);
    return {
      customers: customers
        .map((row) => value(row, "login") || value(row, "name"))
        .filter(Boolean)
        .filter((entry, index, all) => all.indexOf(entry) === index),
      profiles: profiles.map((row) => ({
        name: value(row, "name"),
        price: value(row, "price", "0.00"),
        validity: value(row, "validity", "unlimited"),
      })).filter((profile) => Boolean(profile.name)),
      syncedAt: new Date().toISOString(),
    };
  });
}

/**
 * Fetches one report day. The query predicates are evaluated by RouterOS before
 * rows are returned, allowing the browser to continue a multi-day report job
 * through short worker requests instead of one timeout-prone request.
 */
export async function fetchUserManagerReportDay(router: RouterRow, mode: RouterMode, date: string): Promise<UserManagerReportRow[]> {
  return withConnection(router, async (conn) => {
    const base = mode.majorVersion === 6 ? "/tool/user-manager" : "/user-manager";
    const sessionPath = `${base}/session/print`;
    const userPath = `${base}/user/print`;
    const profilePath = `${base}/profile/print`;
    const profileMapPath = mode.majorVersion === 6 ? null : "/user-manager/user-profile/print";
    const startedField = mode.majorVersion === 6 ? "from-time" : "started";
    const userField = mode.majorVersion === 6 ? "user" : "user";
    const from = toRouterDate(date, false);
    const until = toRouterDate(date, true);

    const sessionWords = [
      sessionPath,
      `?>${startedField}=${from}`,
      `?<${startedField}=${until}`,
      `=.proplist=.id,${userField},${startedField},nas-port-id`,
    ];
    const [sessions, users, profiles, assignments] = await Promise.all([
      conn.command(sessionWords),
      conn.command([userPath, mode.majorVersion === 6 ? "=.proplist=username,actual-profile" : "=.proplist=name"]),
      conn.command([profilePath, "=.proplist=name,price"]),
      profileMapPath ? conn.command([profileMapPath, "=.proplist=user,profile"]) : Promise.resolve([]),
    ]);

    const profileByName = new Map(profiles.map((row) => [value(row, "name"), value(row, "price", "0.00")]));
    const legacyProfileByUser = new Map(users.map((row) => [value(row, "username"), value(row, "actual-profile")]));
    const v7ProfileByUser = new Map(assignments.map((row) => [value(row, "user"), value(row, "profile")]));
    const earliestByUser = new Map<string, Record<string, string>>();
    for (const session of sessions) {
      const username = value(session, userField);
      const started = value(session, startedField);
      if (!username || !started) continue;
      const previous = earliestByUser.get(username);
      if (!previous || parseRouterTime(started) < parseRouterTime(value(previous, startedField))) earliestByUser.set(username, session);
    }

    return [...earliestByUser.entries()]
      .map(([username, session]) => {
        const profile = mode.majorVersion === 6 ? legacyProfileByUser.get(username) ?? "—" : v7ProfileByUser.get(username) ?? "—";
        return {
          firstLoginDate: value(session, startedField),
          username,
          price: profileByName.get(profile) ?? "0.00",
          profile,
          nasPortId: value(session, "nas-port-id", "—") || "—",
        };
      })
      .sort((a, b) => parseRouterTime(a.firstLoginDate) - parseRouterTime(b.firstLoginDate));
  });
}
