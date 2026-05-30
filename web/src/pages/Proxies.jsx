import { useEffect, useState } from "react";
import {
  Card, CardBody, CardHeader, Button, Checkbox,
  Spinner, Chip, Switch, useDisclosure, Modal, ModalContent, ModalHeader,
  ModalBody, ModalFooter,
} from "@heroui/react";
import { listPools, createPool, patchPool, deletePool, bulkPoolAction, testProxy } from "../lib/api.js";
import { PageHeader, TextField, AreaField, SelectField } from "../components/ui.jsx";

const STRATEGY_OPTS = [
  { key: "round-robin", label: "round-robin" },
  { key: "random", label: "random" },
];

export default function Proxies() {
  const [pools, setPools] = useState(null);
  const [err, setErr] = useState("");
  const [testResults, setTestResults] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const createModal = useDisclosure();

  const load = () => listPools().then((r) => setPools(r.pools)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const runTest = async (poolId) => {
    setTestResults((t) => ({ ...t, [poolId]: "loading" }));
    try {
      const r = await testProxy({ poolId });
      setTestResults((t) => ({ ...t, [poolId]: r.results }));
    } catch (e) { setErr(e.message); setTestResults((t) => ({ ...t, [poolId]: null })); }
  };

  const toggle = (id, on) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const selectedIds = Array.from(selected);

  const runBatch = async (action) => {
    if (!selectedIds.length) return;
    if (action === "delete" && !window.confirm(`确定删除选中的 ${selectedIds.length} 个代理池？此操作不可撤销。`)) return;
    setBatchBusy(true);
    setErr("");
    try {
      await bulkPoolAction(selectedIds, action);
      setSelected(new Set());
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBatchBusy(false); }
  };

  if (err && !pools) return <div className="text-danger">{err}</div>;
  if (!pools) return <div className="flex justify-center py-20"><Spinner /></div>;

  const allSelected = pools.length > 0 && selectedIds.length === pools.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="代理池"
        subtitle={<>支持 <code>socks5://[user:pass@]host:port</code>、<code>socks4://</code>、<code>http(s)://</code>（CONNECT 隧道）。账号可绑定代理池或单独指定 proxy_url；走代理时仍保持 HTTP/2（h2-over-proxy）。</>}
        action={<Button color="primary" onPress={createModal.onOpen}>新建代理池</Button>}
      />
      {err && <div className="text-small text-danger">{err}</div>}

      {pools.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-medium border border-default-100 bg-content1/60 px-3 py-2">
          <Checkbox
            size="sm" isSelected={allSelected}
            isIndeterminate={selectedIds.length > 0 && !allSelected}
            onValueChange={(on) => setSelected(on ? new Set(pools.map((p) => p.id)) : new Set())}
          >
            全选
          </Checkbox>
          {selectedIds.length > 0 && (
            <>
              <span className="text-small text-default-500">已选 <b>{selectedIds.length}</b> 个</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="flat" color="success" isLoading={batchBusy} onPress={() => runBatch("activate")}>批量启用</Button>
                <Button size="sm" variant="flat" isLoading={batchBusy} onPress={() => runBatch("deactivate")}>批量停用</Button>
                <Button size="sm" variant="flat" color="danger" isLoading={batchBusy} onPress={() => runBatch("delete")}>批量删除</Button>
                <Button size="sm" variant="light" onPress={() => setSelected(new Set())}>取消选择</Button>
              </div>
            </>
          )}
        </div>
      )}

      {pools.length === 0 && (
        <div className="rounded-large border border-dashed border-default-200 bg-content1/40 py-12 text-center text-default-500">
          还没有代理池，点右上角新建。
        </div>
      )}

      <div className="grid gap-4">
        {pools.map((p) => (
          <PoolCard
            key={p.id} pool={p} onChange={load} onTest={() => runTest(p.id)} testResult={testResults[p.id]}
            selected={selected.has(p.id)} onToggle={(on) => toggle(p.id, on)}
          />
        ))}
      </div>

      <CreateModal disclosure={createModal} onDone={load} />
    </div>
  );
}

function PoolCard({ pool, onChange, onTest, testResult, selected, onToggle }) {
  const [proxiesText, setProxiesText] = useState(pool.proxies.join("\n"));
  const [strategy, setStrategy] = useState(pool.strategy);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const list = proxiesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await patchPool(pool.id, { proxies: list, strategy });
      onChange?.();
    } finally { setSaving(false); }
  };

  return (
    <Card shadow="sm" className="border border-default-100 bg-content1/80">
      <CardHeader className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-3">
          <Checkbox size="sm" isSelected={!!selected} onValueChange={onToggle} aria-label={`选择 ${pool.name}`} />
          <span className="font-semibold">{pool.name}</span>
          <Chip size="sm" variant="flat">{pool.count} 个代理</Chip>
          <Switch size="sm" isSelected={!!pool.is_active} onValueChange={(v) => patchPool(pool.id, { is_active: v }).then(onChange)}>
            启用
          </Switch>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="flat" onPress={onTest} isLoading={testResult === "loading"}>测试连通性</Button>
          <Button size="sm" variant="flat" color="danger" onPress={() => deletePool(pool.id).then(onChange)}>删除</Button>
        </div>
      </CardHeader>
      <CardBody className="gap-4 p-5">
        <SelectField label="调度策略" className="max-w-[220px]" selectedKeys={[strategy]} onChange={(e) => e.target.value && setStrategy(e.target.value)} options={STRATEGY_OPTS} />
        <AreaField label="代理列表" description="每行一个" minRows={3} value={proxiesText} onValueChange={setProxiesText} />
        <div className="flex justify-end">
          <Button size="sm" color="primary" isLoading={saving} onPress={save}>保存</Button>
        </div>
        {Array.isArray(testResult) && (
          <div className="space-y-1">
            {testResult.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-tiny">
                <Chip size="sm" variant="flat" color={r.ok ? "success" : "danger"}>{r.ok ? `${r.ms}ms` : "失败"}</Chip>
                <span className="font-mono text-default-500">{r.proxyUrl}</span>
                {!r.ok && <span className="text-danger">{r.error}</span>}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function CreateModal({ disclosure, onDone }) {
  const { isOpen, onOpenChange } = disclosure;
  const [name, setName] = useState("");
  const [proxiesText, setProxiesText] = useState("");
  const [strategy, setStrategy] = useState("round-robin");
  const [loading, setLoading] = useState(false);

  const submit = async (close) => {
    setLoading(true);
    try {
      const list = proxiesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await createPool({ name: name.trim(), strategy, proxies: list });
      onDone?.();
      setName(""); setProxiesText("");
      close();
    } finally { setLoading(false); }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="xl">
      <ModalContent>
        {(close) => (
          <>
            <ModalHeader>新建代理池</ModalHeader>
            <ModalBody className="gap-4 pb-2">
              <TextField label="名称" value={name} onValueChange={setName} isRequired />
              <SelectField label="调度策略" selectedKeys={[strategy]} onChange={(e) => e.target.value && setStrategy(e.target.value)} options={STRATEGY_OPTS} />
              <AreaField label="代理列表" description="每行一个" minRows={4} value={proxiesText} onValueChange={setProxiesText}
                placeholder={"socks5://user:pass@host:1080\nhttp://host:8080"} />
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={close}>取消</Button>
              <Button color="primary" isLoading={loading} isDisabled={!name.trim()} onPress={() => submit(close)}>创建</Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
