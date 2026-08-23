import type { Context } from 'hono'
import type { AppEnv } from '../middleware/auth'
import { getProviderByType } from '../storage'
import { transformImage } from './imageTransform'

/**
 * 自动变体生成服务
 *
 * 直传原图（jpeg/png）后自动生成网站展示所需的两个 webp 变体：
 *   {base}.webp     缩略版（最大边 1600，quality 70）
 *   {base}-hd.webp  高清均衡版（最大边 2560，quality 80）
 *
 * 转换基于 Cloudflare Image Resizing（复用 imageTransform），
 * 变体写入 R2 并登记到 images 表（保证 /rest/{key} 可直接访问）。
 * 变体记录以 original_name = 'variant:{原图key}' 标记，便于级联删除与补生成查询。
 */

/** 缩略版规格 */
const THUMB = { width: 1600, height: 1600, quality: 70 }
/** 高清均衡版规格 */
const HD = { width: 2560, height: 2560, quality: 80 }

/** 原图小于该体积时不生成变体（本身已足够小） */
export const MIN_SIZE_FOR_VARIANTS = 200 * 1024

const ORIGINAL_EXT_RE = /\.(jpe?g|png)$/i
const ANY_EXT_RE = /\.(webp|avif|png|jpe?g|gif)$/i

export interface VariantResult {
    thumbKey?: string
    hdKey?: string
    skipped?: string
    error?: string
}

export function baseKeyOf(key: string): string {
    return key.replace(ANY_EXT_RE, '')
}

/**
 * 是否应为该图片自动生成变体：
 * 仅 jpeg/png 原图且体积超过阈值（排除小图、变体本身与 -hd 文件）
 */
export function shouldGenerateVariants(mime: string | null | undefined, key: string, size: number): boolean {
    if (!mime) return false
    const m = mime.toLowerCase()
    if (m !== 'image/jpeg' && m !== 'image/png') return false
    if (!ORIGINAL_EXT_RE.test(key)) return false
    if (baseKeyOf(key).endsWith('-hd')) return false
    return size >= MIN_SIZE_FOR_VARIANTS
}

/** 生成单个变体并写入存储，失败返回 null */
async function generateOne(
    c: Context<AppEnv>,
    originalKey: string,
    variantKey: string,
    spec: { width: number, height: number, quality: number }
): Promise<number | null> {
    const result = await transformImage(c, originalKey, {
        width: spec.width,
        height: spec.height,
        fit: 'scale-down',
        format: 'webp',
        quality: spec.quality
    })
    if (!result.transformed || !result.body) {
        console.warn(`[variant] transform failed for ${originalKey}`)
        return null
    }

    const buf = await new Response(result.body).arrayBuffer()
    const provider = getProviderByType(c, 'R2')
    await provider.put(variantKey, buf, {
        contentType: 'image/webp',
        metadata: { variantOf: originalKey }
    })
    return buf.byteLength
}

/** 登记变体到 images 表（与上传流程字段一致），并更新上传者存储统计 */
async function registerVariant(
    c: Context<AppEnv>,
    key: string,
    size: number,
    originalKey: string,
    folder: string,
    userLogin?: string
): Promise<void> {
    const db = c.env.DB
    await db.prepare(
        `INSERT OR REPLACE INTO images (key, user_id, user_login, original_name, size, mime_type, folder, expires_at, storage_type, tags, nsfw, nsfw_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        key,
        null,
        userLogin || 'system',
        `variant:${originalKey}`,
        size,
        'image/webp',
        folder,
        null,
        'R2',
        null,
        0,
        0
    ).run()

    if (userLogin) {
        await db.prepare(
            'UPDATE users SET storage_used = storage_used + ? WHERE login = ?'
        ).bind(size, userLogin).run()
    }
}

/**
 * 为原图生成全部变体（幂等：存储中已存在的变体跳过，缺 DB 记录则补登记）。
 * 设计为在 DB 入库完成后异步执行（waitUntil / then 链），失败只记日志不影响上传结果。
 */
export async function generateVariants(
    c: Context<AppEnv>,
    originalKey: string,
    opts?: { userLogin?: string, force?: boolean }
): Promise<VariantResult> {
    const userLogin = opts?.userLogin
    const base = baseKeyOf(originalKey)
    const folder = originalKey.includes('/') ? originalKey.substring(0, originalKey.lastIndexOf('/') + 1) : ''
    const thumbKey = `${base}.webp`
    const hdKey = `${base}-hd.webp`
    const provider = getProviderByType(c, 'R2')
    const out: VariantResult = {}

    const targets: Array<{ key: string, spec: typeof THUMB | typeof HD }> = []
    for (const t of [{ key: thumbKey, spec: THUMB }, { key: hdKey, spec: HD }]) {
        if (!opts?.force) {
            const existing = await provider.head(t.key)
            if (existing) {
                // 存储已存在：确保 DB 有记录后跳过
                const row = await c.env.DB.prepare('SELECT key FROM images WHERE key = ?').bind(t.key).first()
                if (!row) {
                    await registerVariant(c, t.key, existing.size, originalKey, folder, userLogin).catch(() => { })
                }
                continue
            }
        }
        targets.push(t)
    }

    if (targets.length === 0) {
        out.skipped = 'variants already exist'
        return out
    }

    for (const t of targets) {
        try {
            const size = await generateOne(c, originalKey, t.key, t.spec)
            if (size == null) {
                out.error = `transform failed: ${t.key}`
                continue
            }
            await registerVariant(c, t.key, size, originalKey, folder, userLogin)
            if (t.key === thumbKey) out.thumbKey = t.key
            else out.hdKey = t.key
            console.log(`[variant] generated ${t.key} (${(size / 1024).toFixed(0)}KB) from ${originalKey}`)
        } catch (e) {
            console.error(`[variant] failed for ${t.key}:`, e)
            out.error = `${t.key}: ${(e as Error).message}`
        }
    }

    return out
}

/** 删除原图时级联删除其变体（存储 + DB + 用户统计） */
export async function deleteVariantsOf(c: Context<AppEnv>, originalKey: string): Promise<void> {
    const base = baseKeyOf(originalKey)
    const keys = [`${base}.webp`, `${base}-hd.webp`]
    const db = c.env.DB
    for (const key of keys) {
        try {
            const row = await db.prepare('SELECT size, user_login FROM images WHERE key = ?')
                .bind(key).first<{ size: number, user_login: string }>()
            await getProviderByType(c, 'R2').delete(key)
            if (row) {
                await db.prepare('DELETE FROM images WHERE key = ?').bind(key).run()
                if (row.user_login) {
                    await db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE login = ?')
                        .bind(row.size, row.user_login).run()
                }
            }
        } catch (e) {
            console.error(`[variant] failed to delete variant ${key}:`, e)
        }
    }
}
