/**
 * 图片缩略图 URL 生成工具
 * 依赖后端边缘转换能力（Cloudflare Image Resizing）：
 *   /rest/{key}?width=200&height=200&fit=cover
 * 浏览器请求头携带 Accept: image/webp 时后端自动返回 WebP/AVIF。
 * 转换不可用时后端自动回退原图，因此前端可放心使用。
 */

export interface ThumbnailOptions {
    width?: number
    height?: number
    fit?: 'cover' | 'contain' | 'scale-down' | 'crop' | 'pad'
    /** 不指定时由后端按浏览器 Accept 头自动协商（webp/avif） */
    format?: 'webp' | 'avif' | 'jpeg' | 'png' | 'auto'
    quality?: number
}

/**
 * 为本站 /rest/ 图片链接追加缩放参数，生成缩略图 URL。
 * 第三方链接（data:、blob:、外链等）原样返回。
 */
export function thumbnailUrl(url: string | undefined | null, opts?: ThumbnailOptions): string {
    if (!url) return ''
    if (!opts || (!opts.width && !opts.height && !opts.format && !opts.quality)) return url

    // 只处理本站图片接口，避免污染外链 / 本地临时对象
    if (!url.includes('/rest/')) return url

    const params = new URLSearchParams()
    if (opts.width) params.set('width', String(opts.width))
    if (opts.height) params.set('height', String(opts.height))
    if (opts.fit) params.set('fit', opts.fit)
    if (opts.format) params.set('format', opts.format)
    if (opts.quality) params.set('quality', String(opts.quality))

    const qs = params.toString()
    if (!qs) return url
    return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`
}

/**
 * 按设备像素比计算实际请求宽度，保证 Retina 屏清晰度
 */
export function dprWidth(cssWidth: number): number {
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
    return Math.round(cssWidth * Math.min(dpr, 2))
}

/**
 * 原生 <img> 加载失败回退：将 src 切回原图。
 * 仅在当前 src 与原图不同时切换，避免回退仍失败时无限循环。
 * 用法：@error="fallbackToOriginal($event, originalUrl)"
 */
export function fallbackToOriginal(e: Event, originalUrl: string | undefined | null): void {
    const img = e.target as HTMLImageElement
    if (!img || !originalUrl) return
    if (img.getAttribute('src') !== originalUrl) {
        img.setAttribute('src', originalUrl)
    }
}
