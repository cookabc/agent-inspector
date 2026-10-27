/* 纯函数：不碰 DOM，也不碰网络。
 *
 * 单独放一个文件是为了能被 node --test 直接 import —— 前端其余部分
 * 要 document 才能跑，而"字节怎么写成人类读得懂的字"恰恰是最容易算错、
 * 也最该被测试盯住的那一类（它算错的后果是屏幕上出现不存在的数字）。
 */

const GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;

/**
 * 一行文件能不能被选中清理。
 *
 * 判据只有两条，但它们必须是全前端唯一的一份：
 *
 *   · verdict === 'never' —— 凭据、数据库、配置。服务端锁死，界面也锁
 *   · link —— 软链接。扫描按链接本身记录（不跟随），服务端一律拒绝删除
 *
 * 判据只能有这一份。逐处各判一次的话，只要有一处漏掉软链接那一半，
 * 选区就会混进删不掉的条目，而服务端「先校验全批再动手」→ 整批被拒，
 * 用户看到的是"明明勾上了却删不掉"，错误信息却只提那一个文件。
 *
 * 失败方向必须是「不放行」：缺省按 'never'，判不出来就不许勾。
 * 缺省若按 'review'（默认可勾），一旦分类表与规则表短暂不一致
 * （加规则忘了补分类），未归类的东西就成了默认可清理项。两种错法
 * 代价不对称 —— 让新分类暂时不能删，好过让受保护的东西被删。
 *
 * @param {{link?: boolean, c: string}} file 扫描出来的文件行
 * @param {{verdict?: string}} [cat] 该行所属分类（缺省时按不可清理处理）
 */
export function isSelectable(file, cat) {
  if (file.link) return false;
  const verdict = cat?.verdict;
  if (!verdict) return false;          // 判不出来 → 不许勾
  return verdict !== 'never';
}

/**
 * 体积转文字。一律 1024 进制 —— 界面上每个数都可以悬停看精确字节数。
 *
 * 精度刻意分档（10 GB 以上只留一位），但**必须防止进位成 1024**：
 * 1073741000 字节按 MB 算是 1023.999，留一位小数会印成 "1024.0 MB" ——
 * 那不是任何一个量级的写法，读的人会以为算错了。所以四舍五入之后
 * 一旦够到 1024，就换再大的单位重新算。
 *
 * 顶上必须有足够大的单位兜住：只列到 TB 的话，1024 TB 会停在 "1024.00 TB"
 * （循环条件 i > 0 让它无处可去）。PB / EB 这两档在磁盘审计里几乎用不到，
 * 但它们的存在是"任何体积都不会印出 1024"这条不变量的一部分。
 */
export function fmtBytes(n) {
  /* 入口先归一：任何非有限数、负数、非数字都当 0。
     实测过 NaN / undefined / Infinity / -1 会原样印成 "NaN B"、"undefined B"、
     "Infinity EB"、"-1 B"（目录用 -1 当哨兵），而界面上一旦出现这些字样，
     人只会以为工具算错了 —— 宁可显示 0 B 并让别处去解释真正的原因。 */
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) n = 0;
  else n = num;

  const UNITS = [
    ['EB', 1024 ** 6, 2],
    ['PB', 1024 ** 5, 2],
    ['TB', 1024 ** 4, 2],
    ['GB', GB, 2],
    ['MB', MB, 1],
    ['KB', KB, 0],
  ];
  let i = UNITS.findIndex(([, size]) => n >= size);
  if (i < 0) return `${n} B`;

  const at = (idx) => {
    const [unit, size, dp] = UNITS[idx];
    // 10 GB 以上只留一位：写 "1.8 GB" 比 "1.79 GB" 好读，量级已经说明问题了
    const d = unit === 'GB' && n >= 10 * GB ? 1 : dp;
    return { unit, d, v: Number((n / size).toFixed(d)) };
  };

  let { unit, d, v } = at(i);
  while (v >= 1024 && i > 0) {
    i -= 1;
    ({ unit, d, v } = at(i));
  }
  return `${v.toFixed(d)} ${unit}`;
}
