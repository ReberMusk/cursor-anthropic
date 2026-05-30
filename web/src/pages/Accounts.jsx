import { useEffect, useState, useCallback } from "react";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Chip, Button, Spinner, useDisclosure, Modal, ModalContent, ModalHeader,
  ModalBody, ModalFooter, Input, Tabs, Tab, Tooltip, Switch,
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem,
} from "@heroui/react";
import {
  listAccounts, importAccount, bulkImport, patchAccount, activateAccount,
  deactivateAccount, resetCooldown, regenMachineId, testAccount, deleteAccount,
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

export default function Accounts() {
  const [accounts, setAccounts] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState({});
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

      <div className="rounded-large border border-default-100 bg-content1/80 p-2">
      <Table aria-label="accounts" removeWrapper isStriped>
        <TableHeader>
          <TableColumn>名称 / 邮箱</TableColumn>
          <TableColumn>优先级</TableColumn>
          <TableColumn>状态</TableColumn>
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
                      if (key === "toggle") act(a.id, () => (a.is_active ? deactivateAccount(a.id) : activateAccount(a.id)));
                      if (key === "cooldown") act(a.id, () => resetCooldown(a.id));
                      if (key === "regen") act(a.id, () => regenMachineId(a.id));
                      if (key === "delete") act(a.id, () => deleteAccount(a.id));
                    }}>
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
  const [bulk, setBulk] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const reset = () => { setToken(""); setName(""); setMachineId(""); setBulk(""); setResult(null); setError(""); };

  const submitSingle = async () => {
    setError(""); setResult(null); setLoading(true);
    try {
      const r = await importAccount({ accessToken: token.trim(), name: name.trim() || undefined, machineId: machineId.trim() || undefined, ghostMode: ghost });
      setResult({ single: r });
      onDone?.();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const submitBulk = async () => {
    setError(""); setResult(null); setLoading(true);
    try {
      const r = await bulkImport(bulk);
      setResult({ bulk: r });
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
                      description="每行一个：token，或 token----machineId / token,machineId；也支持粘贴 JSON 数组"
                      minRows={8} value={bulk} onValueChange={setBulk}
                      placeholder={"ey...token1\ney...token2----<machineId>\n[{\"accessToken\":\"ey...\",\"name\":\"a\"}]"}
                    />
                  </div>
                </Tab>
              </Tabs>

              {error && <div className="text-small text-danger">{error}</div>}
              {result?.single && <div className="text-small text-success">已{result.single.created ? "导入" : "更新"}：{result.single.account.name || result.single.account.user_id}</div>}
              {result?.bulk && (
                <div className="text-small">
                  <span className="text-success">导入 {result.bulk.imported} · 更新 {result.bulk.updated}</span>
                  {result.bulk.skipped > 0 && <span className="text-danger"> · 跳过 {result.bulk.skipped}</span>}
                  {result.bulk.errors?.length > 0 && (
                    <ul className="mt-1 text-tiny text-danger list-disc pl-4">
                      {result.bulk.errors.slice(0, 5).map((e, i) => <li key={i}>第 {e.line} 行: {e.reason}</li>)}
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
