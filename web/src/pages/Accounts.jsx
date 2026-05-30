import { useEffect, useState, useCallback } from "react";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Chip, Button, Spinner, useDisclosure, Modal, ModalContent, ModalHeader,
  ModalBody, ModalFooter, Input, Tabs, Tab, Tooltip, Switch,
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem,
} from "@heroui/react";
import {
  listAccounts, importAccount, bulkImport, patchAccount, activateAccount,
  deactivateAccount, resetCooldown, regenMachineId, testAccount, refreshUsage, deleteAccount,
  bulkAccountAction,
} from "../lib/api.js";
import { PageHeader, TextField, AreaField } from "../components/ui.jsx";

const STATUS_COLOR = {
  active: "success", rate_limited: "warning", error: "danger",
  expired: "danger", disabled: "default",
};

function StatusChip({ a }) {
  const status = a.is_active ? a.status : "disabled";
  const cooling = a.cooldown_until && new Date(a.cooldown_until).getTime() > Date.now();
  let label = status;
  if (cooling) {
    const secs = Math.max(0, Math.round((new Date(a.cooldown_until).getTime() - Date.now()) / 1000));
    label = `${status} · ${secs}s`;
  }
  return <Chip size="sm" variant="flat" color={STATUS_COLOR[status] || "default"}>{label}</Chip>;
}

function UsageCell({ a }) {
  if (a.usage_checked_at == null && a.usage_cents == null) {
    return <span className="text-tiny text-default-400">—</span>;
  }
  const amount = typeof a.usage_cents === "number" ? a.usage_cents / 100 : 0;
  const checked = a.usage_checked_at ? new Date(a.usage_checked_at).toLocaleString() : "未知";
  const lastActive = a.last_active_at ? new Date(a.last_active_at).toLocaleString() : "无记录";
  return (
    <Tooltip content={<div className="text-tiny">计费事件 {a.usage_events ?? 0} 条<br />最近活跃 {lastActive}<br />检测于 {checked}</div>}>
      <div className="leading-tight">
        <div className="text-small font-medium">${amount.toFixed(2)}</div>
        <div className="text-tiny text-default-400">{a.usage_events ?? 0} 事件</div>
      </div>
    </Tooltip>
  );
}

const BATCH_LABELS = {
  activate: "批量启用", deactivate: "批量停用",
  "reset-cooldown": "清除冷却", delete: "批量删除",
};

export default function Accounts() {
  const [accounts, setAccounts] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const importModal = useDisclosure();

  const load = useCallback(() => listAccounts().then((r) => setAccounts(r.accounts)).catch((e) => setErr(e.message)), []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (id, fn) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await fn(); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const selectedIds = selected === "all"
    ? (accounts || []).map((a) => a.id)
    : Array.from(selected);

  const runBatch = async (action) => {
    if (!selectedIds.length) return;
    if (action === "delete" && !window.confirm(`确定删除选中的 ${selectedIds.length} 个账号？此操作不可撤销。`)) return;
    setBatchBusy(true);
    setErr("");
    try {
      await bulkAccountAction(selectedIds, action);
      setSelected(new Set());
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBatchBusy(false); }
  };

  if (err && !accounts) return <div className="text-danger">{err}</div>;
  if (!accounts) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="space-y-5">
      <PageHeader
        title="账号池"
        count={accounts.length}
        subtitle="每个 Cursor 账号自动派生稳定的设备码（machineId），重复导入按账号幂等。"
        action={<Button color="primary" onPress={importModal.onOpen}>导入账号</Button>}
      />
      {err && <div className="text-small text-danger">{err}</div>}

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-medium border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-small">已选 <b>{selectedIds.length}</b> 个账号</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="flat" color="success" isLoading={batchBusy} onPress={() => runBatch("activate")}>{BATCH_LABELS.activate}</Button>
            <Button size="sm" variant="flat" isLoading={batchBusy} onPress={() => runBatch("deactivate")}>{BATCH_LABELS.deactivate}</Button>
            <Button size="sm" variant="flat" color="warning" isLoading={batchBusy} onPress={() => runBatch("reset-cooldown")}>{BATCH_LABELS["reset-cooldown"]}</Button>
            <Button size="sm" variant="flat" color="danger" isLoading={batchBusy} onPress={() => runBatch("delete")}>{BATCH_LABELS.delete}</Button>
            <Button size="sm" variant="light" onPress={() => setSelected(new Set())}>取消选择</Button>
          </div>
        </div>
      )}

      <div className="rounded-large border border-default-100 bg-content1/80 p-2">
      <Table
        aria-label="accounts" removeWrapper isStriped
        selectionMode="multiple" selectedKeys={selected} onSelectionChange={setSelected}
      >
        <TableHeader>
          <TableColumn>名称 / 邮箱</TableColumn>
          <TableColumn>优先级</TableColumn>
          <TableColumn>状态</TableColumn>
          <TableColumn>近30天额度</TableColumn>
          <TableColumn>machineId</TableColumn>
          <TableColumn>请求 / 错误</TableColumn>
          <TableColumn>过期</TableColumn>
          <TableColumn>最近错误</TableColumn>
          <TableColumn align="end">操作</TableColumn>
        </TableHeader>
        <TableBody emptyContent="还没有账号，点右上角导入。">
          {accounts.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                <div className="font-medium">{a.name || a.user_id || "(未命名)"}</div>
                <div className="text-tiny text-default-400">{a.email || a.token_preview}</div>
              </TableCell>
              <TableCell>
                <Input
                  size="sm" type="number" className="w-20" defaultValue={String(a.priority)}
                  onBlur={(e) => { const v = Number(e.target.value); if (v && v !== a.priority) act(a.id, () => patchAccount(a.id, { priority: v })); }}
                />
              </TableCell>
              <TableCell><StatusChip a={a} /></TableCell>
              <TableCell><UsageCell a={a} /></TableCell>
              <TableCell><span className="font-mono text-tiny">{(a.machine_id || "").slice(0, 14)}…</span></TableCell>
              <TableCell><span className="text-small">{a.total_requests} / <span className="text-danger">{a.total_errors}</span></span></TableCell>
              <TableCell><span className="text-tiny text-default-500">{a.expires_at ? new Date(a.expires_at).toLocaleDateString() : "—"}</span></TableCell>
              <TableCell><span className="text-tiny text-danger">{a.last_error ? a.last_error.slice(0, 40) : ""}</span></TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Tooltip content="发探测请求">
                    <Button size="sm" variant="flat" isLoading={busy[a.id]} onPress={() => act(a.id, async () => {
                      const r = await testAccount(a.id);
                      if (!r.ok) setErr(`测试失败: ${r.error || r.status}`);
                    })}>测试</Button>
                  </Tooltip>
                  <Dropdown>
                    <DropdownTrigger><Button size="sm" variant="light" isIconOnly>⋯</Button></DropdownTrigger>
                    <DropdownMenu aria-label="actions" onAction={(key) => {
                      if (key === "usage") act(a.id, async () => {
                        const r = await refreshUsage(a.id);
                        if (!r.ok) setErr(`刷新额度失败: ${r.error || r.status}`);
                      });
                      if (key === "toggle") act(a.id, () => (a.is_active ? deactivateAccount(a.id) : activateAccount(a.id)));
                      if (key === "cooldown") act(a.id, () => resetCooldown(a.id));
                      if (key === "regen") act(a.id, () => regenMachineId(a.id));
                      if (key === "delete") act(a.id, () => deleteAccount(a.id));
                    }}>
                      <DropdownItem key="usage">刷新额度</DropdownItem>
                      <DropdownItem key="toggle">{a.is_active ? "停用" : "启用"}</DropdownItem>
                      <DropdownItem key="cooldown">清除冷却</DropdownItem>
                      <DropdownItem key="regen">重新生成 machineId</DropdownItem>
                      <DropdownItem key="delete" className="text-danger" color="danger">删除</DropdownItem>
                    </DropdownMenu>
                  </Dropdown>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>

      <ImportModal disclosure={importModal} onDone={load} />
    </div>
  );
}

function ImportModal({ disclosure, onDone }) {
  const { isOpen, onOpenChange, onClose } = disclosure;
  const [tab, setTab] = useState("single");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [machineId, setMachineId] = useState("");
  const [ghost, setGhost] = useState(true);
  const [check, setCheck] = useState(true);
  const [bulk, setBulk] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const reset = () => { setToken(""); setName(""); setMachineId(""); setBulk(""); setResult(null); setError(""); };

  const submitSingle = async () => {
    setError(""); setResult(null); setLoading(true);
    try {
      const r = await importAccount({ accessToken: token.trim(), name: name.trim() || undefined, machineId: machineId.trim() || undefined, ghostMode: ghost, check });
      setResult({ single: r });
      onDone?.();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const submitBulk = async () => {
    setError(""); setResult(null); setLoading(true);
    try {
      const r = await bulkImport(bulk, check);
      setResult({ bulk: r });
      // Keep only the failed lines in the textarea so the user can fix & retry.
      if (r.failedText !== undefined) setBulk(r.failedText);
      onDone?.();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" onClose={reset}>
      <ModalContent>
        {(close) => (
          <>
            <ModalHeader>导入 Cursor 账号</ModalHeader>
            <ModalBody>
              <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
                <Tab key="single" title="单个">
                  <div className="space-y-4 pt-2">
                    <AreaField label="Access Token (JWT)" minRows={3} value={token} onValueChange={setToken} placeholder="ey..." isRequired />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <TextField label="备注名" description="可选" value={name} onValueChange={setName} />
                      <TextField label="machineId" description="留空则从 token 稳定派生" value={machineId} onValueChange={setMachineId} />
                    </div>
                    <Switch isSelected={ghost} onValueChange={setGhost} size="sm">Ghost 模式（隐私）</Switch>
                    <div className="text-tiny text-default-400">不填 machineId 会从 token 确定性派生一个稳定的 64 位 hex 设备码（同一账号始终一致，避免「设备过多」）。邮箱/过期时间从 JWT 自动解析。</div>
                  </div>
                </Tab>
                <Tab key="bulk" title="批量">
                  <div className="space-y-2 pt-2">
                    <AreaField
                      label="批量导入"
                      description="每行一个账号，字段用 ---- 分隔，顺序随意：会自动识别 token（JWT，支持 user_xxx::token 或 URL 编码的 %3A%3A）、邮箱、machineId。machineId 留空将从 token 自动派生，无需填写。也支持粘贴 JSON 数组。"
                      minRows={8} value={bulk} onValueChange={setBulk}
                      placeholder={"email----password----password----user_xxx%3A%3AeyJ...token\ney...token2\n[{\"accessToken\":\"ey...\",\"name\":\"a\"}]"}
                    />
                  </div>
                </Tab>
              </Tabs>

              <div className="flex items-center justify-between rounded-medium bg-default-100 px-3 py-2">
                <div className="text-tiny text-default-500">
                  导入前校验令牌有效性并获取近30天额度（无效令牌不会被添加；批量模式下会保留在输入框中）
                </div>
                <Switch isSelected={check} onValueChange={setCheck} size="sm" />
              </div>

              {error && <div className="text-small text-danger">{error}</div>}
              {result?.single && (
                <div className="text-small text-success">
                  已{result.single.created ? "导入" : "更新"}：{result.single.account.name || result.single.account.user_id}
                  {result.single.usage && (
                    <span className="text-default-500">
                      {" "}· 近30天额度 ${Number(result.single.usage.totalAmount || 0).toFixed(2)}（{result.single.usage.includedEvents || 0} 事件）
                    </span>
                  )}
                </div>
              )}
              {result?.bulk && (
                <div className="text-small">
                  <span className="text-success">导入 {result.bulk.imported} · 更新 {result.bulk.updated}</span>
                  {result.bulk.skipped > 0 && <span className="text-danger"> · 跳过 {result.bulk.skipped}（无效令牌已保留在上方输入框）</span>}
                  {result.bulk.errors?.length > 0 && (
                    <ul className="mt-1 text-tiny text-danger list-disc pl-4">
                      {result.bulk.errors.slice(0, 8).map((e, i) => <li key={i}>第 {e.line} 行: {e.reason}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={() => { reset(); close(); }}>关闭</Button>
              {tab === "single"
                ? <Button color="primary" isLoading={loading} onPress={submitSingle} isDisabled={!token.trim()}>导入</Button>
                : <Button color="primary" isLoading={loading} onPress={submitBulk} isDisabled={!bulk.trim()}>批量导入</Button>}
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
