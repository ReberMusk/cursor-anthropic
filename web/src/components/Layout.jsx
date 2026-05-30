import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button, Tooltip } from "@heroui/react";
import { useTheme } from "next-themes";
import { logout } from "../lib/api.js";

const NAV = [
  { to: "/", label: "概览", icon: "▦" },
  { to: "/accounts", label: "账号池", icon: "◉" },
  { to: "/proxies", label: "代理池", icon: "⇄" },
  { to: "/keys", label: "API 密钥", icon: "🔑" },
  { to: "/settings", label: "设置", icon: "⚙" },
];

export function ThemeToggle({ className = "" }) {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <Tooltip content={isDark ? "切换到浅色" : "切换到深色"} placement="right">
      <Button
        isIconOnly
        size="sm"
        variant="flat"
        radius="full"
        aria-label="切换主题"
        className={className}
        onPress={() => setTheme(isDark ? "light" : "dark")}
      >
        <span className="text-base">{isDark ? "☀" : "☾"}</span>
      </Button>
    </Tooltip>
  );
}

export default function Layout({ children, user, onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();

  const doLogout = async () => {
    try { await logout(); } catch {}
    onLogout?.();
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r border-default-100 bg-content1/70 backdrop-blur-sm flex flex-col sticky top-0 h-screen">
        <div className="px-5 py-6 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 text-white font-bold shadow-lg shadow-primary/30">
            C
          </div>
          <div className="leading-tight flex-1 min-w-0">
            <div className="text-base font-semibold truncate">cursor-anthropic</div>
            <div className="text-tiny text-default-500">Cursor → Anthropic 网关</div>
          </div>
          <ThemeToggle />
        </div>

        <nav className="flex-1 px-3 space-y-1 mt-2">
          {NAV.map((n) => {
            const active = location.pathname === n.to;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`group flex items-center gap-3 rounded-medium px-3 py-2.5 text-small transition-all ${
                  active
                    ? "bg-primary/15 text-primary font-medium ring-1 ring-primary/20"
                    : "text-default-500 hover:bg-default-100/70 hover:text-default-700"
                }`}
              >
                <span className={`w-5 text-center text-base ${active ? "" : "opacity-70 group-hover:opacity-100"}`}>{n.icon}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-4 border-t border-default-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="grid h-8 w-8 place-items-center rounded-full bg-default-200 text-default-600 text-small font-medium uppercase">
              {(user?.username || "?").slice(0, 1)}
            </div>
            <div className="min-w-0 leading-tight">
              <div className="text-small text-default-700 truncate">{user?.username}</div>
              <div className="text-tiny text-default-400">管理员</div>
            </div>
          </div>
          <Button size="sm" variant="flat" color="danger" className="w-full" onPress={doLogout}>
            退出登录
          </Button>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
      </div>
    </div>
  );
}
