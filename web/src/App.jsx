import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Spinner } from "@heroui/react";
import { me, UNAUTHORIZED_EVENT } from "./lib/api.js";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Accounts from "./pages/Accounts.jsx";
import Proxies from "./pages/Proxies.jsx";
import Keys from "./pages/Keys.jsx";
import Settings from "./pages/Settings.jsx";

export default function App() {
  const [auth, setAuth] = useState({ loading: true, user: null });
  const location = useLocation();

  const refresh = () =>
    me()
      .then((u) => setAuth({ loading: false, user: u }))
      .catch(() => setAuth({ loading: false, user: null }));

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const onUnauthorized = () => setAuth({ loading: false, user: null });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (auth.loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (!auth.user) {
    if (location.pathname === "/login") return <Login onLoggedIn={refresh} />;
    return <Navigate to="/login" replace />;
  }

  return (
    <Layout user={auth.user} onLogout={() => setAuth({ loading: false, user: null })}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/proxies" element={<Proxies />} />
        <Route path="/keys" element={<Keys />} />
        <Route path="/settings" element={<Settings onPasswordChanged={refresh} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
