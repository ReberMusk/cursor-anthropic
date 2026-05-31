import { useEffect, useState } from "react";
import { Button, Spinner, Switch, Divider } from "@heroui/react";
import { getSettings, saveScheduler, saveGateway, changePassword } from "../lib/api.js";
import { PageHeader, SectionCard, NumberField, SelectField, TextField, AreaField } from "../components/ui.jsx";

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
        <SelectField
          label="工具调用处理"
          description="Cursor 后端不会把客户端声明的工具暴露给模型（实测：会被丢弃，模型转而调用 Cursor 原生工具并泄漏给客户端）。simulate：把工具写进提示、以纯 Chat 模式运行、解析模型输出的标记块还原成 tool_use——支持任意工具（函数工具 + Anthropic 类型工具）。native：仅把少数 Claude Code 工具映射到 Cursor 原生工具（有损，自定义工具会失败）。"
          selectedKeys={[gateway.toolMode || "simulate"]}
          onChange={(e) => e.target.value && setGateway((g) => ({ ...g, toolMode: e.target.value }))}
          options={[
            { key: "simulate", label: "simulate（提示工程模拟，推荐）", description: "支持任意工具，纯 Chat 模式" },
            { key: "native", label: "native（原生工具映射，遗留）", description: "仅少数 CC 工具，自定义工具失败" },
          ]}
        />

        <Divider className="bg-default-100" />

        <SelectField
          label="Cursor 对话模式"
          description="决定下发给 Cursor 的模式。默认 Agent，否则纯文本提问会进入 Ask（只读）模式，Cursor 会拒绝写文件 / 执行命令等工具调用。"
          selectedKeys={[gateway.cursorMode || "agent"]}
          onChange={(e) => e.target.value && setGateway((g) => ({ ...g, cursorMode: e.target.value }))}
          options={[
            { key: "agent", label: "Agent（推荐）", description: "始终 Agent 模式，模型可调用工具" },
            { key: "ask", label: "Ask（只读）", description: "除非请求自带 tools，否则只读问答" },
            { key: "auto", label: "Auto", description: "仅对 claude-cli/claude-code 客户端启用 Agent" },
          ]}
        />

        <Divider className="bg-default-100" />

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

        <Divider className="bg-default-100" />

        <AreaField
          label="账号级异常的报错关键词（支持关键字匹配）"
          description="一行一个报错提示，自行去后台日志抓取（大小写不敏感、子串匹配）。命中的报错会被标记为账号级异常（冷却该账号并切换到下一个）；未命中的（如参数错误 Max Mode Required）不会禁用账号，直接以 400 返回给客户端。HTTP 401（鉴权失败）/429（限速）始终视为账号级；403 交由关键词判断。留空则使用程序内置默认列表（limited、unpaid、out of usage、suspicious activity 等）。"
          minRows={8}
          value={(gateway.accountErrorKeywords || []).join("\n")}
          onValueChange={(v) => setGateway((g) => ({ ...g, accountErrorKeywords: v.split(/\r?\n/) }))}
          placeholder={"You're out of usage\nslow pool\npay your invoice"}
        />
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
