import { useEffect, useState } from "react";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Chip, Spinner, Snippet, useDisclosure, Modal, ModalContent,
  ModalHeader, ModalBody, ModalFooter,
} from "@heroui/react";
import { listKeys, createKey, activateKey, deactivateKey, deleteKey } from "../lib/api.js";
import { PageHeader, TextField } from "../components/ui.jsx";

export default function Keys() {
  const [keys, setKeys] = useState(null);
  const [envKeySet, setEnvKeySet] = useState(false);
  const [err, setErr] = useState("");
  const createModal = useDisclosure();

  const load = () => listKeys().then((r) => { setKeys(r.keys); setEnvKeySet(r.envKeySet); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err && !keys) return <div className="text-danger">{err}</div>;
  if (!keys) return <div className="flex justify-center py-20"><Spinner /></div>;

  const open = !envKeySet && keys.filter((k) => k.is_active).length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="API 密钥"
        subtitle={<>客户端用 <code>x-api-key: sk-ca-…</code>（或 <code>Authorization: Bearer</code>）调用 <code>/v1/messages</code>。</>}
        action={<Button color="primary" onPress={createModal.onOpen}>生成密钥</Button>}
      />
      {open && (
        <div className="rounded-medium border border-warning/30 bg-warning/10 px-4 py-3 text-small text-warning-600">
          ⚠ 当前无任何密钥且未设置 <code>GATEWAY_API_KEY</code> —— <code>/v1/messages</code> 处于开放状态，建议生成一个密钥。
        </div>
      )}
      {err && <div className="text-small text-danger">{err}</div>}

      <div className="rounded-large border border-default-100 bg-content1/80 p-2">
      <Table aria-label="api keys" removeWrapper isStriped>
        <TableHeader>
          <TableColumn>名称</TableColumn>
          <TableColumn>前缀</TableColumn>
          <TableColumn>状态</TableColumn>
          <TableColumn>调用次数</TableColumn>
          <TableColumn>最近使用</TableColumn>
          <TableColumn align="end">操作</TableColumn>
        </TableHeader>
        <TableBody emptyContent="还没有密钥。">
          {keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell>{k.name || "(未命名)"}</TableCell>
              <TableCell><span className="font-mono text-tiny">{k.key_prefix}…</span></TableCell>
              <TableCell><Chip size="sm" variant="flat" color={k.is_active ? "success" : "default"}>{k.is_active ? "启用" : "停用"}</Chip></TableCell>
              <TableCell>{k.total_requests}</TableCell>
              <TableCell><span className="text-tiny text-default-500">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "—"}</span></TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="flat" onPress={() => (k.is_active ? deactivateKey(k.id) : activateKey(k.id)).then(load)}>
                    {k.is_active ? "停用" : "启用"}
                  </Button>
                  <Button size="sm" variant="flat" color="danger" onPress={() => deleteKey(k.id).then(load)}>删除</Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>

      <CreateModal disclosure={createModal} onDone={load} />
    </div>
  );
}

function CreateModal({ disclosure, onDone }) {
  const { isOpen, onOpenChange } = disclosure;
  const [name, setName] = useState("");
  const [created, setCreated] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      const r = await createKey(name.trim() || undefined);
      setCreated(r.key);
      onDone?.();
    } finally { setLoading(false); }
  };

  const reset = () => { setName(""); setCreated(null); };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} onClose={reset}>
      <ModalContent>
        {(close) => (
          <>
            <ModalHeader>生成 API 密钥</ModalHeader>
            <ModalBody className="gap-3">
              {!created ? (
                <TextField label="名称" description="可选" value={name} onValueChange={setName} autoFocus />
              ) : (
                <div className="space-y-2">
                  <div className="text-small text-warning">⚠ 该密钥只显示这一次，请立即保存：</div>
                  <Snippet symbol="" variant="flat" className="w-full">{created}</Snippet>
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              {!created
                ? (<><Button variant="flat" onPress={close}>取消</Button><Button color="primary" isLoading={loading} onPress={submit}>生成</Button></>)
                : (<Button color="primary" onPress={() => { reset(); close(); }}>完成</Button>)}
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
