import { GenerationResult, GeneratorSettings } from "@/types";

/**
 * Faithful port of the original generateNumbers() logic from the legacy HTML tool.
 * - Generates `numCount` unique random numeric strings of length `numLength`,
 *   each starting with `beginNumber`, padded with random digits.
 * - Builds the MikroTik User Manager script exactly as before (add + create-and-activate-profile),
 *   including the run-date variable and log lines.
 */
export function generateCards(settings: GeneratorSettings): GenerationResult {
  const customer = settings.customer.trim().replace(/\s+/g, "");
  const comment = settings.comment.trim().replace(/\s+/g, "");
  const profile = settings.profile.trim().replace(/\s+/g, "");
  const { passwordType, numLength: length, numCount: count } = settings;

  if (length < 5) {
    throw new Error("خطأ: يجب أن يكون طول الرقم 5 أو أكثر!");
  }
  if (count < 1) {
    throw new Error("خطأ: عدد الأرقام يجب أن يكون 1 أو أكثر!");
  }

  const numbers: string[] = [];
  const seen = new Set<string>();
  let script = "";

  script += `/log info "بدء إنشاء المستخدمين للعميل ${customer}";\n`;
  script += `:local scriptRunDate [/system clock get date];\n`;

  // Safety cap to avoid an infinite loop if length/count combination can't produce
  // enough unique values (mirrors original behavior but guards against hangs).
  const maxAttempts = count * 200 + 10000;
  let attempts = 0;

  while (numbers.length < count && attempts < maxAttempts) {
    attempts++;
    let candidate = settings.beginNumber.toString();
    while (candidate.length < length) {
      candidate += Math.floor(Math.random() * 10);
    }

    if (seen.has(candidate)) continue;
    seen.add(candidate);
    numbers.push(candidate);

    const password = passwordType === "same" ? candidate : '""';

    script +=
      `/log info "إنشاء مستخدم جديد: ${candidate}";\n` +
      `/tool user-manager user add customer=${customer} username=${candidate} password=${password} first-name=("SABA-CREATED:" . $scriptRunDate) comment=${comment};\n` +
      `/tool user-manager user create-and-activate-profile customer=${customer} profile=${profile} "${candidate}";\n`;
  }

  if (numbers.length < count) {
    throw new Error(
      "تعذّر توليد العدد المطلوب من الأرقام الفريدة بطول الرقم الحالي. جرّب زيادة طول الرقم أو تقليل العدد."
    );
  }

  script += `/log info "اكتمال إنشاء المستخدمين للعميل ${customer} - العدد الإجمالي: ${count}";\n`;

  return { numbers, script };
}

export function buildFileName(params: {
  profile: string;
  suffix: string;
  usedNumbers: number;
  date?: Date;
}): string {
  // Use the same readable title for the PDF and MikroTik script. The extension
  // identifies the artifact type, so the library stays grouped by one card run.
  const date = (params.date ?? new Date()).toISOString().slice(0, 10);
  const safePart = (value: string, fallback: string) =>
    (value.trim() || fallback).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  const profile = safePart(params.profile, "profile");
  const suffix = safePart(params.suffix, "0");
  return `${profile}_${suffix}_${params.usedNumbers}_${date}`;
}
