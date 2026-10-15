// Talking to the server. Every error becomes an ApiError with a plain-language message.
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error ?? 'Something went wrong.');
    this.status = status;
    this.code = data?.code;
    this.details = data?.details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pos' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', error: 'Could not reach the server. Check the connection and try again. Nothing was saved.' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data;
}

/** Download a file (spreadsheet export) while keeping the sign-in cookie. Returns the file name that was saved. */
export async function download(path, fallbackName) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'X-Requested-With': 'pos' } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}
