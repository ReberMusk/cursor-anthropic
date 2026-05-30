import { useEffect, useState } from "react";
import { Button, Spinner, Switch, Divider } from "@heroui/react";
import { getSettings, saveScheduler, saveGateway, changePassword } from "../lib/api.js";
import { PageHeader, SectionCard, NumberField, SelectField, TextField } from "../components/ui.jsx";

const FIELD_HELP = {
  stickyLimit: "同一账号连续命中的最大次数（round-robin 下）",
  transientCooldownMs: "未知/瞬时错误的冷却时长 (ms)",
  backoffBaseMs: "限速退避的基准时长 (ms)",
  backoffMaxMs: "退避时长上限 (ms)",
  backoffMaxLevel: "退避指数的最大级别",
};

export default function Settings({ onPasswordChanged }) {
  const [sched, setSched] = useState(null);
  const [gateway, setGateway] = useState(null);
  const [err, setErr] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then((r) => { setSched(r.scheduler); setGateway(r.gateway); }).catch((e) => setErr(e.message));
  }, []);

  const save = async () => {
    setSaving(true); setSavedMsg("");
    try { await saveScheduler(sched); await saveGateway(gateway); setSavedMsg("已保存"); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); setTimeout(() => setSavedMsg(""), 2000); }
  };

  if (err && !sched) return <div className="text-danger">{err}</div>;
  if (!sched || !gateway) return <div className="flex justify-center py-20"><Spinner /></div>;

  const num = (k) => (
    <NumberField
      label={k}
      description={FIELD_HELP[k]}
      value={String(sched[k])}
      onValueChange={(v) => setSched((s) => ({ ...s, [k]: Number(v) }))}
    />
  );

  const SaveRow = (
    <div className="flex items-center gap-3 pt-1">
      <Button color="primary" isLoading={saving} onPress={save}>保存更改</Button>
      {savedMsg && <span className="text-small text-success">✓ {savedMsg}</span>}
    </div>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="设置" subtitle="调度策略、响应行为与管理员账户。" />

      <SectionCard title="调度策略" desc="决定请求如何在账号池中分配，以及失败后的冷却/退避行为。">
        <SelectField
          label="分配策略"
          selectedKeys={[sched.strategy]}
          onChange={(e) => e.target.value && setSched((s) => ({ ...s, strategy: e.target.value }))}
          options={[
            { key: "fill-first", label: "fill-first（填满优先）", description: "始终用优先级最高的可用账号，限速后再切换" },
            { key: "round-robin", label: "round-robin（轮询）", description: "在可用账号间轮询，均摊负载" },
          ]}
        />

        <Divider className="bg-default-100" />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-5">
          {num("stickyLimit")}
          {num("transientCooldownMs")}
          {num("backoffBaseMs")}
          {num("backoffMaxMs")}
          {num("backoffMaxLevel")}
        </div>
        {SaveRow}
      </SectionCard>

      <SectionCard title="响应行为">
        <div className="flex items-start justify-between gap-4 rounded-medium border border-default-100 bg-content2/40 p-4">
          <div className="space-y-1">
            <div className="font-medium text-foreground">下发 thinking 块</div>
            <div className="text-tiny text-default-500 max-w-xl">
              把 Cursor 返回的思考过程作为 Anthropic <code>thinking</code> 块下发（流式 <code>thinking_delta</code>）。
              默认关闭——这些块没有 Anthropic 签名，部分客户端（含 Claude Code）可能拒绝。需客户端在请求里启用 <code>thinking</code> 才会有内容。
            </div>
          </div>
          <Switch
            isSelected={!!gateway.emitThinking}
            onValueChange={(v) => setGateway((g) => ({ ...g, emitThinking: v }))}
          />
        </div>
        {SaveRow}
      </SectionCard>

      <PasswordCard onChanged={onPasswordChanged} />
    </div>
  );
}

function PasswordCard({ onChanged }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setMsg(""); setErr(""); setLoading(true);
    try {
      await changePassword(cur, next);
      setMsg("密码已修改"); setCur(""); setNext("");
      onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <SectionCard title="修改管理员密码">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <TextField label="当前密码" type="password" value={cur} onValueChange={setCur} />
        <TextField label="新密码" description="至少 6 位" type="password" value={next} onValueChange={setNext} />
      </div>
      {err && <div className="text-small text-danger">{err}</div>}
      {msg && <div className="text-small text-success">✓ {msg}</div>}
      <div>
        <Button color="primary" isLoading={loading} isDisabled={next.length < 6} onPress={submit}>修改密码</Button>
      </div>
    </SectionCard>
  );
}
