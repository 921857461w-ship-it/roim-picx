import type { Context } from 'hono'
import type { AppEnv } from '../middleware/auth'

/**
 * 图片边缘转换服务
 * 基于 Cloudflare Image Resizing，在边缘节点实时缩放 / 格式转换：
 *   /rest/{key}?width=200&height=200&fit=cover
 * WebP/AVIF 转换通过请求头 Accept: image/webp 自动协商（format=auto）。
 */

export interface ImageTransformOptions {
    width?: number
    height?: number
    fit?: 'cover' | 'contain' | 'scale-down' | 'crop' | 'pad'
    /** 显式输出格式；不指定时由 Cloudflare 依据 Accept 头自动协商（webp/avif） */
    format?: 'webp' | 'avif' | 'jpeg' | 'png' | 'baseline-jpeg' | 'png-force' | 'svg' | 'auto'
    quality?: number
}

const FIT_VALUES = ['cover', 'contain', 'scale-down', 'crop', 'pad']
const FORMAT_VALUES = ['webp', 'avif', 'jpeg', 'png', 'baseline-jpeg', 'png-force', 'svg', 'auto']

/** 允许转换的最大尺寸，防止滥用导致边缘资源消耗 */
const MAX_DIMENSION = 4096

/**
 * 从查询参数解析并校验转换参数，非法参数返回 null
 */
export function parseTransformOptions(query: URLSearchParams): ImageTransformOptions | null {
    const opts: ImageTransformOptions = {}

    const width = query.get('width') || query.get('w')
    if (width) {
        const n = parseInt(width, 10)
        if (isNaN(n) || n <= 0 || n > MAX_DIMENSION) return null
        opts.width = n
    }

    const height = query.get('height') || query.get('h')
    if (height) {
        const n = parseInt(height, 10)
        if (isNaN(n) || n <= 0 || n > MAX_DIMENSION) return null
        opts.height = n
    }

    const fit = query.get('fit')
    if (fit) {
        if (!FIT_VALUES.includes(fit)) return null
        opts.fit = fit as ImageTransformOptions['fit']
    }

    const format = query.get('format') || query.get('f')
    if (format) {
        if (!FORMAT_VALUES.includes(format)) return null
        opts.format = format as ImageTransformOptions['format']
    }

    const quality = query.get('quality') || query.get('q')
    if (quality) {
        const n = parseInt(quality, 10)
        if (isNaN(n) || n < 1 || n > 100) return null
        opts.quality = n
    }

    return opts
}

export function hasTransformOptions(opts: ImageTransformOptions): boolean {
    return !!(opts.width || opts.height || opts.fit || opts.format || opts.quality)
}

/**
 * GIF / SVG 等格式无法安全缩放或转换，跳过处理直接返回原图
 */
export function isTransformable(contentType?: string | null): boolean {
    if (!contentType) return true
    const ct = contentType.toLowerCase()
    if (ct.includes('svg')) return false
    if (ct.includes('gif')) return false
    return ct.startsWith('image/')
}

function toCfImageOptions(opts: ImageTransformOptions): Record<string, any> {
    const cf: Record<string, any> = {}
    if (opts.width) cf.width = opts.width
    if (opts.height) cf.height = opts.height
    if (opts.fit) cf.fit = opts.fit
    if (opts.quality) cf.quality = opts.quality
    // 未显式指定格式时使用 auto：依据浏览器 Accept 头自动输出 avif/webp
    cf.format = opts.format || 'auto'
    return cf
}

export interface TransformResult {
    body: ReadableStream | null
    contentType?: string
    transformed: boolean
}

/**
 * 通过 Cloudflare Image Resizing 转换图片。
 * 优先使用 R2 公共域名（R2_PUBLIC_DOMAIN，需在 R2 控制台启用 Image Resizing）；
 * 否则回退到站点自身 URL + fetch cf.image 选项；
 * 转换不可用 / 失败时返回 transformed=false，由调用方回退原图。
 */
export async function transformImage(
    c: Context<AppEnv>,
    key: string,
    opts: ImageTransformOptions
): Promise<TransformResult> {
    const cfImage = toCfImageOptions(opts)
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')

    // 1. 优先：R2 公共桶域名（r2.dev / 自定义域），Image Resizing 完全在边缘完成
    const r2PublicDomain = (c.env as any).R2_PUBLIC_DOMAIN as string | undefined
    if (r2PublicDomain) {
        try {
            const base = r2PublicDomain.replace(/\/+$/, '')
            const url = `${base}/cdn-cgi/image/${cfOptionsToPath(cfImage)}/${encodedKey}`
            const resp = await fetch(url, {
                headers: { Accept: c.req.header('accept') || 'image/*' },
                cf: { cacheEverything: true } as any
            })
            if (resp.ok) {
                return {
                    body: resp.body,
                    contentType: resp.headers.get('content-type') || undefined,
                    transformed: true
                }
            }
        } catch (e) {
            console.error('[image-transform] R2 public domain transform failed:', e)
        }
    }

    // 2. 回退：请求站点自身原图 URL，附带 cf.image 选项触发边缘转换
    try {
        const origin = new URL(c.req.url).origin
        const url = `${origin}/rest/${encodedKey}`
        const resp = await fetch(url, {
            headers: { Accept: c.req.header('accept') || 'image/*' },
            cf: { image: cfImage } as any
        })
        if (resp.ok) {
            return {
                body: resp.body,
                contentType: resp.headers.get('content-type') || undefined,
                transformed: true
            }
        }
    } catch (e) {
        console.error('[image-transform] cf.image transform failed:', e)
    }

    return { body: null, transformed: false }
}

function cfOptionsToPath(cf: Record<string, any>): string {
    const parts: string[] = []
    if (cf.width) parts.push(`width=${cf.width}`)
    if (cf.height) parts.push(`height=${cf.height}`)
    if (cf.fit) parts.push(`fit=${cf.fit}`)
    if (cf.quality) parts.push(`quality=${cf.quality}`)
    if (cf.format && cf.format !== 'auto') parts.push(`format=${cf.format}`)
    return parts.join(',')
}
