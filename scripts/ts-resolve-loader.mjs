/**
 * ts-resolve-loader.mjs — 让 Node 直接加载 engine/*.ts 的极简 loader 钩子
 *
 * engine 源码采用打包器风格的无扩展名相对导入（import './rules'），
 * Node 原生 ESM 不支持这种写法；本钩子只补一件事：
 *   相对路径无扩展名时依次尝试 .ts / /index.ts
 * .ts 文件的类型擦除交给 Node 内置 type stripping（Node >= 22.18 默认开启；
 * 22.6 ~ 22.17 需加 --experimental-strip-types）。
 *
 * 零第三方依赖，不需要 npm install。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const hasExt = /\.(ts|mts|cts|js|mjs|cjs|json)$/.test(specifier)
  if (!isRelative || hasExt || !context.parentURL) {
    return nextResolve(specifier, context)
  }
  for (const suffix of ['.ts', '/index.ts']) {
    const candidateUrl = new URL(specifier + suffix, context.parentURL)
    if (existsSync(fileURLToPath(candidateUrl))) {
      return nextResolve(specifier + suffix, context)
    }
  }
  return nextResolve(specifier, context)
}
