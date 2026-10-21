/* 纯函数：不碰 DOM，也不碰网络。
 *
 * 单独放一个文件是为了能被 node --test 直接 import —— 前端其余部分
 * 要 document 才能跑，而"字节怎么写成人类读得懂的字"恰恰是最容易算错、
 * 也最该被测试盯住的那一类（它算错的后果是屏幕上出现不存在的数字）。
 */

export const GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;

/**
 * 一行文件能不能被选中清理。
 *
 * 判据只有两条，但它们必须是全前端唯一的一份：
 *
 *   · verdict === 'never' —— 凭据、数据库、配置。服务端锁死，界面也锁
 *   · link —— 软链接。扫描按链接本身记录（不跟随），服务端一律拒绝删除
 *
 * 为什么单独抽出来：这里曾经散着四份判断，行级复选框那份是对的，
 * 而「分组全选」「推荐清理」「三块分组」各自漏了软链接那一半。于是
 * 点「推荐清理」→ 选区里混进一个软链接 → 服务端「先校验全批再动手」→
 * 整批被拒。用户看到的是"明明勾上了却删不掉"，而错误信息只提了那一个文件。
 *
 * @param {{link?: boolean, c: string}} file 扫描出来的文件行
 * @param {{verdict?: string}} [cat] 该行所属分类（缺省时按 unknown 处理）
 */
export function isSelectable(file, cat) {
  const verdict = cat?.verdict ?? 'review';
  return verdict !== 'never' && !file.link;
}

/**
 * 体积转文字。一律 1024 进制 —— 界面上每个数都可以悬停看精确字节数。
 *
 * 精度刻意分档（10 GB 以上只留一位），但**必须防止进位成 1024**：
 * 1073741000 字节按 MB 算是 1023.999，留一位小数会印成 "1024.0 MB" ——
 * 那不是任何一个量级的写法，读的人会以为算错了。所以四舍五入之后
 * 一旦够到 1024，就换再大的单位重新算。
 */
export function fmtBytes(n) {
  const UNITS = [
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
