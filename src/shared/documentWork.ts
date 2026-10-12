/**
 * TPA 独立文稿：共享契约总入口（向后兼容的 barrel）。
 *
 * 协议常量与编码在 `documentWorkProtocol.ts`，记录解析在 `documentWorkParse.ts`；
 * 既有导入路径 `shared/documentWork` 继续有效。
 */
export * from "./documentWorkProtocol";
export * from "./documentWorkParse";
