/**
 * 带"并发合流"的过期缓存。
 *
 * server.mjs 里原来有四份长得几乎一样的实现（文件索引、单 app 会话、
 * Cursor 独占量分析、安全审计），每一份都是：
 *
 *   let cache = null;  let inflight = null;  const TTL = ...;
 *   读的时候先看 cache 新鲜不新鲜 → 命中就返回
 *   否则看 inflight：有就搭车，没有就开一趟
 *   拿到结果时检查 epoch（期间有没有人写过盘），没变才写缓存
 *   invalidate 里把这两个都清掉
 *
 * 四份手抄的问题不在于行数，而在于**漏一处就是真 bug**：比如忘了清
 * inflight，下一次请求会拿到上一轮已经 resolve 的 Promise；忘了 epoch
 * 检查，就会把"写操作之前算出来的旧值"缓存进"写操作之后"。这类错误
 * 不会报错，只会让界面显示过期数字。
 *
 * 收成一个东西之后，这些约束只有一处实现，也就只有一处会错。
 */

/**
 * @param {object} p
 * @param {number} p.ttlMs 多久算过期
 * @param {() => number} p.epoch 读取当前的写代数（写操作每做一次就 +1）
 */
export function createCache({ ttlMs, epoch = () => 0 }) {
  let entry = null;      // { data, at, epoch }
  let inflight = null;

  /**
   * 取数据。
   *
   * @param {object} p
   * @param {boolean} [p.force] 忽略现有缓存
   * @param {() => Promise<any>} p.load 真正的加载函数（同一时刻只会跑一趟）
   * @returns {Promise<{data: any, cached: boolean}>}
   */
  async function get({ force = false, load }) {
    if (!force && entry && Date.now() - entry.at < ttlMs) {
      return { data: entry.data, cached: true };
    }
    if (!inflight) {
      // 进这一趟时记下代数；结果回来时如果代数变了，说明这期间有人写过盘，
      // 算出来的结果可能已经过期 —— 照常返回给这一趟的调用方，但不写缓存。
      const startedAt = epoch();
      inflight = (async () => {
        try {
          const data = await load();
          if (epoch() === startedAt) entry = { data, at: Date.now(), epoch: startedAt };
          return data;
        } finally {
          inflight = null;
        }
      })();
    }
    return { data: await inflight, cached: false };
  }

  /** 清空。写操作之后必须调，否则下一屏拿到的还是旧数字。 */
  function invalidate() {
    entry = null;
    inflight = null;
  }

  /** 只读一下当前缓存（给测试与调试用）。 */
  function peek() {
    return entry;
  }

  return { get, invalidate, peek };
}
