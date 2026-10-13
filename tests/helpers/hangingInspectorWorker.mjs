// 永不回消息、也不主动退出：用来验证宿主能在时限内 terminate 真实 worker。
// 用忙等而不是 sleep，确保「同步计算中无法被 Promise.race 打断」的场景被真实覆盖。
import { parentPort } from "node:worker_threads";

let spin = 0;
parentPort?.on("message", () => {});
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) spin += 1;
void spin;
