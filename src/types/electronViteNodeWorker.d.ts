/// <reference types="electron-vite/node" />

// `?nodeWorker` / `?modulePath` 的类型声明来自 electron-vite 自带的 node.d.ts；
// 这里显式挂一个引用，保证 `tsc --noEmit` 在 src 下能找到它（主进程 worker 入口用得到）。
