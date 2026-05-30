import { useState } from "react";
import { Card, CardBody, Button } from "@heroui/react";
import { login } from "../lib/api.js";
import { TextField } from "../components/ui.jsx";

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      onLoggedIn?.();
    } catch (err) {
      setError(err.message || "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-bg flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-primary-400 to-primary-600 text-white text-2xl font-bold shadow-xl shadow-primary/30">
            C
          </div>
          <div>
            <div className="text-xl font-semibold">cursor-anthropic</div>
            <div className="text-small text-default-500">Cursor → Anthropic 网关 · 管理端</div>
          </div>
        </div>

        <Card shadow="lg" className="border border-default-100 bg-content1/80">
          <CardBody className="p-6">
            <form onSubmit={submit} className="space-y-5">
              <TextField label="用户名" value={username} onValueChange={setUsername} autoFocus isRequired />
              <TextField label="密码" type="password" value={password} onValueChange={setPassword} isRequired />
              {error && <div className="text-small text-danger">{error}</div>}
              <Button type="submit" color="primary" className="w-full font-medium" isLoading={loading}>
                登录
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
