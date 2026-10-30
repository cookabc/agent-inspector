/**
 * 零依赖的 Chrome DevTools Protocol 客户端。
 *
 * scripts/ 下三个测量脚本都要做同一件事：起一个 headless Chrome、
 * 拿到页面 target 的 WebSocket、发 Runtime.evaluate。这段样板抄三份
 * 最容易"改一处忘两处"（尤其 result/exceptionDetails 的嵌套层级 ——
 * 写错时真正的报错会被 undefined 吞掉），所以收成一份。
 *
 * 用 Node 自带的 WebSocket（22.0 起全局可用），不引任何第三方包。
 */

import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * 起一个 headless Chrome 并连上它的第一个页面。
 *
 * @param {{port:number, profile?:string, size?:[number,number]}} opts
 * @returns {Promise<{evaluate:Function, screenshot:Function, goto:Function, close:Function}>}
 */
export async function launch({ port, profile = 'agent-inspector-cdp', size = [1440, 1000], executable = process.env.CHROME_PATH || CHROME }) {
  const proc = spawn(executable, [
    '--headless=new', ...(process.env.CI ? ['--no-sandbox'] : []), `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/${profile}`, '--no-first-run',
    `--window-size=${size[0]},${size[1]}`, 'about:blank',
  ], { stdio: 'ignore' });
  let spawnError;
  proc.on('error', err => { spawnError = err; });
  const exited = new Promise(resolve => proc.once('close', resolve));
  const stop = async () => {
    proc.kill();
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000); })]);
    clearTimeout(timer);
    await exited;
  };

  let info = null;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (spawnError) throw new Error(`Chrome 启动失败：${spawnError.code}`, { cause: spawnError });
    if (proc.exitCode !== null) throw new Error(`Chrome 已退出：${proc.exitCode}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      info = list.find((t) => t.type === 'page');
      if (info) break;
    } catch { /* 还没起来 */ }
  }
  if (!info) { await stop(); throw new Error('Chrome 没起来'); }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Chrome WebSocket 连接超时')), 10000);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error('Chrome WebSocket 连接失败')); };
    });
  } catch (err) { ws.close(); await stop(); throw err; }

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  ws.onclose = () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Chrome 连接已关闭')); }
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('Chrome 连接不可用')); return; }
    const id = ++seq;
    // 全视图测量可耗时数分钟，但连接丢失或永不返回的请求不能无限挂起。
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 600000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try { await send('Page.enable'); }
  catch (err) { ws.close(); await stop(); throw err; }

  return {
    send,
    /** 导航并等某个选择器出现。 */
    async goto(url, waitFor) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        const probe = await send('Runtime.evaluate', {
          expression: `Boolean(document.querySelector(${JSON.stringify(waitFor)}))`,
          returnByValue: true,
        });
        if (probe.result?.value) return;
      }
      throw new Error(`等不到 ${waitFor}`);
    },
    /**
     * 在页面里跑一段代码并取回 JSON。
     *
     * 坑：CDP 把成功结果放在 `{result: {type, value}}`，异常放在**同一层**的
     * `exceptionDetails`。写成 `(await send(...)).result.value` 会在出错时
     * 抛一句 "Cannot read properties of undefined" —— 真正的原因被吃掉。
     */
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails);
        throw new Error(desc.slice(0, 1200));
      }
      return res.result.value;
    },
    /** 截当前视口，返回 PNG Buffer。 */
    async screenshot() {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(shot.data, 'base64');
    },
    async close() {
      try { ws.close(); } catch { /* 已关 */ }
      await stop();
    },
  };
}
