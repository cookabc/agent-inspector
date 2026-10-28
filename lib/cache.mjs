/**
 * 带"并发合流"与写代数校验的过期缓存。
 *
 * 这个形状（缓存 + inflight + epoch）在 server.mjs 里出现过四份手抄，
 * 而它漏任何一句都不会报错：忘了清 inflight，下一次请求拿到上一轮已
 * resolve 的 Promise；忘了 epoch 检查，"写盘之前算的旧值"会缓存进
 * "写盘之后"。收成一处实现，这些约束只有一处会错。
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
    const startedAt = epoch();
    if (!force && entry && entry.epoch === startedAt && Date.now() - entry.at < ttlMs) {
      return { data: entry.data, cached: true };
    }
    if (!inflight || inflight.epoch !== startedAt) {
      // 进这一趟时记下代数；结果回来时如果代数变了，说明这期间有人写过盘，
      // 算出来的结果可能已经过期 —— 照常返回给这一趟的调用方，但不写缓存。
      const flight = { epoch: startedAt, promise: null };
      inflight = flight;
      // 先登记身份再执行 load，兼容同步抛错；旧请求只能清理自己的状态。
      flight.promise = Promise.resolve().then(async () => {
        try {
          const data = await load();
          if (inflight === flight && epoch() === startedAt) entry = { data, at: Date.now(), epoch: startedAt };
          return data;
        } finally {
          if (inflight === flight) inflight = null;
        }
      });
    }
    return { data: await inflight.promise, cached: false };
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
