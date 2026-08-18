import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Download, RefreshCw } from "lucide-react";
import { routersApi, sabaApi, type SabaReportJob, type SabaReportRow } from "@/services/api";
import { useAppStore } from "@/stores/appStore";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function downloadCsv(rows: SabaReportRow[]) {
  const header = ["First login", "Username", "Price", "Profile", "NAS port ID"];
  const escape = (value: string) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = rows.map(({ row_data: row }) => [row.firstLoginDate, row.username, row.price, row.profile, row.nasPortId].map(escape).join(","));
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "saba-userman-report.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const selectedRouterId = useAppStore((state) => state.selectedRouterId);
  const [routers, setRouters] = useState<{ id: string; name: string }[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today());
  const [job, setJob] = useState<SabaReportJob | null>(null);
  const [rows, setRows] = useState<SabaReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    routersApi.list().then((data) => setRouters(data)).catch((error) => toast.error(error.message));
  }, []);

  const selectedRouter = useMemo(() => routers.find((router) => router.id === selectedRouterId), [routers, selectedRouterId]);

  const refreshRows = async (jobId: string, requestedPage = page) => {
    const result = await sabaApi.reports.rows(jobId, requestedPage, 50);
    setRows(result.data);
    setTotal(result.total);
  };

  const runReport = async () => {
    if (!selectedRouterId) {
      toast.error("اختر جهاز MikroTik من صفحة الأجهزة أولاً");
      return;
    }
    if (!from || !to || from > to) {
      toast.error("حدد نطاق تاريخ صالحاً للتقرير");
      return;
    }
    setLoading(true);
    setRows([]);
    setPage(1);
    try {
      let current = await sabaApi.reports.createUserManager(selectedRouterId, from, to);
      setJob(current);
      // One bounded RouterOS day is fetched in each request. This loop is safe
      // to resume because every completed day and its rows are checkpointed.
      while (current.status !== "completed") {
        current = await sabaApi.reports.continue(current.id);
        setJob(current);
        await refreshRows(current.id, 1);
        if (current.status === "failed") throw new Error(current.error_message || "فشل تحميل التقرير");
      }
      await refreshRows(current.id, 1);
      toast.success("اكتمل تحميل التقرير وحُفظ في Supabase");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "فشل تحميل التقرير");
    } finally {
      setLoading(false);
    }
  };

  const changePage = async (nextPage: number) => {
    if (!job || nextPage < 1 || (nextPage - 1) * 50 >= total) return;
    setPage(nextPage);
    await refreshRows(job.id, nextPage);
  };

  const pageCount = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="space-y-5" dir="rtl">
      <div>
        <p className="text-sm font-semibold text-sky-600">USER MANAGER</p>
        <h1 className="text-2xl font-black text-slate-900">تقرير المستخدمين</h1>
        <p className="mt-1 text-sm text-slate-500">لا يتم الاتصال بـ MikroTik عند فتح الصفحة. اضغط تحميل التقرير فقط عندما تحتاج بيانات جديدة.</p>
      </div>

      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
            <span className="block text-xs text-slate-500">الجهاز المحدد</span>
            <strong>{selectedRouter?.name ?? "لا يوجد جهاز محدد"}</strong>
          </div>
          <div className="space-y-2"><Label htmlFor="report-from">من تاريخ</Label><Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="report-to">إلى تاريخ</Label><Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button onClick={runReport} disabled={loading}><RefreshCw className={loading ? "ml-2 h-4 w-4 animate-spin" : "ml-2 h-4 w-4"} />{loading ? "جارٍ التحميل على دفعات…" : "تحميل التقرير من MikroTik"}</Button>
          <Button variant="outline" onClick={() => downloadCsv(rows)} disabled={!rows.length}><Download className="ml-2 h-4 w-4" />تنزيل CSV للصفحة</Button>
        </div>
        {job && <p className="mt-4 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">الحالة: <strong>{job.status}</strong> — تم فحص {job.processed_rows} سجل من الأيام المطلوبة. {job.cursor?.next_date ? `اليوم التالي: ${job.cursor.next_date}` : ""}</p>}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b p-4"><h2 className="font-bold">نتيجة التقرير</h2><span className="text-sm text-slate-500">{total} بطاقة/مستخدم</span></div>
        {!rows.length ? <div className="p-8 text-center text-sm text-slate-500">لم يتم تحميل أي تقرير بعد. اختر نطاق التاريخ ثم اضغط زر التحميل.</div> : (
          <>
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-right text-sm"><thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">تاريخ أول دخول</th><th className="p-3">اسم المستخدم</th><th className="p-3">السعر</th><th className="p-3">الملف</th><th className="p-3">NAS Port ID</th></tr></thead><tbody>{rows.map(({ row_number, row_data }) => <tr key={row_number} className="border-t"><td className="p-3">{row_data.firstLoginDate}</td><td className="p-3 font-mono">{row_data.username}</td><td className="p-3">{row_data.price}</td><td className="p-3">{row_data.profile}</td><td className="p-3">{row_data.nasPortId}</td></tr>)}</tbody></table></div>
            <div className="flex items-center justify-between p-4 text-sm"><Button variant="outline" onClick={() => changePage(page - 1)} disabled={page <= 1}>السابق</Button><span>صفحة {page} من {pageCount}</span><Button variant="outline" onClick={() => changePage(page + 1)} disabled={page >= pageCount}>التالي</Button></div>
          </>
        )}
      </Card>
    </div>
  );
}
