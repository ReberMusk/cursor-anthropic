// Thin fetch wrapper for the admin REST API. Cookies carry the admin session.

async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.raw || res.statusText;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request("GET", p),
  post: (p, b) => request("POST", p, b),
  put: (p, b) => request("PUT", p, b),
  patch: (p, b) => request("PATCH", p, b),
  del: (p) => request("DELETE", p),
};

// auth
export const login = (username, password) => api.post("/api/auth/login", { username, password });
export const logout = () => api.post("/api/auth/logout");
export const me = () => api.get("/api/auth/me");
export const changePassword = (currentPassword, newPassword) => api.post("/api/auth/change-password", { currentPassword, newPassword });

// dashboard + settings
export const getDashboard = () => api.get("/api/dashboard");
export const getSettings = () => api.get("/api/settings");
export const saveScheduler = (s) => api.put("/api/settings/scheduler", s);
export const saveGateway = (g) => api.put("/api/settings/gateway", g);

// accounts
export const listAccounts = () => api.get("/api/accounts");
export const importAccount = (a) => api.post("/api/accounts", a);
export const bulkImport = (text) => api.post("/api/accounts/bulk-import", { text });
export const patchAccount = (id, f) => api.patch(`/api/accounts/${id}`, f);
export const activateAccount = (id) => api.post(`/api/accounts/${id}/activate`);
export const deactivateAccount = (id) => api.post(`/api/accounts/${id}/deactivate`);
export const resetCooldown = (id) => api.post(`/api/accounts/${id}/reset-cooldown`);
export const regenMachineId = (id) => api.post(`/api/accounts/${id}/regenerate-machine-id`);
export const testAccount = (id, model) => api.post(`/api/accounts/${id}/test`, model ? { model } : {});
export const deleteAccount = (id) => api.del(`/api/accounts/${id}`);

// proxy pools
export const listPools = () => api.get("/api/proxy-pools");
export const createPool = (p) => api.post("/api/proxy-pools", p);
export const patchPool = (id, f) => api.patch(`/api/proxy-pools/${id}`, f);
export const deletePool = (id) => api.del(`/api/proxy-pools/${id}`);
export const testProxy = (payload) => api.post("/api/proxy-pools/test", payload);

// api keys
export const listKeys = () => api.get("/api/keys");
export const createKey = (name) => api.post("/api/keys", { name });
export const activateKey = (id) => api.post(`/api/keys/${id}/activate`);
export const deactivateKey = (id) => api.post(`/api/keys/${id}/deactivate`);
export const deleteKey = (id) => api.del(`/api/keys/${id}`);
