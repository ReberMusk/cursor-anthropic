import { useEffect, useState } from "react";
import { Card, CardBody, Spinner, Chip } from "@heroui/react";
import { getDashboard } from "../lib/api.js";
import { PageHeader, SectionCard } from "../components/ui.jsx";

const ACCENT = {
  default: "text-default-700",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  primary: "text-primary",
  secondary: "text-secondary",
};
const DOT = {
  default: "bg-default-300",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  primary: "bg-primary",
  secondary: "bg-secondary",
};

function Stat({ label, value, color = "default" }) {
  return (
    <Card shadow="sm" className="border border-default-100 bg-content1/80">
      <CardBody className="gap-1.5 p-5">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[color]}`} />
          <div className="text-tiny uppercase tracking-wide text-default-500">{label}</div>
        </div>
        <div className={`text-3xl font-semibold tabular-nums ${ACCENT[color]}`}>{value}</div>
      </CardBody>
    </Card>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  const load = () => getDashboard().then(setData).catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (err) return <div className="text-danger">{err}</div>;
  if (!data) return <div className="flex justify-center py-20"><Spinner /></div>;

  const a = data.accounts;
  const u = data.usage24h;
  const okRate = u.total ? Math.round((u.ok / u.total) * 100) : 100;

  return (
    <div className="space-y-6">
      <PageHeader title="概览" subtitle="账号池与网关运行状态实时快照（每 5 秒刷新）。" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="账号总数" value={a.total} />
        <Stat label="可用" value={a.active} color="success" />
        <Stat label="限速中" value={a.rate_limited} color="warning" />
        <Stat label="错误 / 过期" value={a.error + a.expired} color="danger" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="冷却中" value={a.cooling} color="warning" />
        <Stat label="已停用" value={a.disabled} color="default" />
        <Stat label="启用密钥" value={data.apiKeys} color="primary" />
        <Stat label="代理池" value={data.proxyPools} color="secondary" />
      </div>

      <SectionCard title="近 24 小时用量">
        <div className="flex flex-wrap items-center gap-8">
          <div>
            <div className="text-3xl font-semibold tabular-nums">{u.total}</div>
            <div className="text-tiny text-default-500">总请求</div>
          </div>
          <div className="flex items-center gap-3">
            <Chip color="success" variant="flat">成功 {u.ok}</Chip>
            <Chip color="danger" variant="flat">失败 {u.errors}</Chip>
          </div>
          <div className="flex-1 min-w-[180px]">
            <div className="flex justify-between text-tiny text-default-500 mb-1">
              <span>成功率</span><span className="tabular-nums">{okRate}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-default-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${okRate >= 80 ? "bg-success" : okRate >= 50 ? "bg-warning" : "bg-danger"}`}
                style={{ width: `${okRate}%` }}
              />
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
