import { Hono } from 'hono'
import { Ok, Fail, Build, ImgItem } from '../type'
import type { User } from '../type'
import { checkFileType, getFileName, rewriteImageOrigin } from '../utils'
import { auth, type AppEnv } from '../middleware/auth'
import { uploadRateLimit } from '../middleware/rateLimit'
import { getStorageProvider, getProviderByType } from '../storage'
import { ensureFolderRecords } from './folders'
import { shouldGenerateVariants, generateVariants } from '../services/variantGenerator'

const uploadRoutes = new Hono<AppEnv>()

/**
 * 从文件相对路径（如 'photos/travel/a.jpg'）提取并清洗目录部分，
 * 返回以 / 结尾的目录前缀（如 'photos/travel/'）；无目录时返回 ''。
 */
function sanitizeRelativeFolder(relativePath: string | undefined | null): string {
    if (!relativePath) return ''
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    const parts = normalized.split('/')
    if (parts.length <= 1) return ''
    const dirs = parts.slice(0, -1)
        .map(seg => seg.trim().replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_'))
        .filter(seg => seg.length > 0 && seg !== '.' && seg !== '..')
    if (dirs.length === 0) return ''
    return dirs.join('/') + '/'
}

// batch upload file (with rate limiting)
uploadRoutes.post('/upload', uploadRateLimit, auth, async (c) => {
    const files = await c.req.formData()
    const images = files.getAll("files")
    // 与 files 一一对应的相对路径（文件夹上传时前端附带，用于自动创建目录）
    const relativePaths = files.getAll("relativePaths").map(v => v.toString())
    let customPath = files.get("path")
    const keepName = files.get("keepName") === 'true'
    // 传 skipVariants=true 可跳过自动变体生成
    const skipVariants = files.get("skipVariants") === 'true'
    const expireAt = files.get("expireAt")
    const tagsRaw = files.get("tags")?.toString()
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0) : []
    const nsfw = files.get("nsfw") === 'true' ? 1 : 0
    const nsfwScoreRaw = files.get("nsfwScore")
    const nsfwScore = nsfwScoreRaw ? parseFloat(nsfwScoreRaw.toString()) : 0

    const requestedStorageType = files.get("storageType")?.toString() as 'R2' | 'HF' | undefined
    const storageType: 'R2' | 'HF' = (requestedStorageType === 'R2' || requestedStorageType === 'HF')
        ? requestedStorageType
        : (c.env.STORAGE_TYPE || 'R2')

    // Validate Album ID if present
    const albumIds = files.getAll("albumId").map(id => parseInt(id.toString())).filter(id => !isNaN(id))
    // Usually only one albumId is passed, but for robust handling we take the first or all? 
    // Requirements say "Upload to designated album", implying one album.
    const albumId = albumIds.length > 0 ? albumIds[0] : null

    // Get authenticated user info from context
    const user = c.get('user') as User | undefined
    const storage = getProviderByType(c, storageType)

    if (customPath) {
        customPath = customPath.toString()
        if (!customPath.endsWith('/')) {
            customPath += '/'
        }
        // Remove leading slash if present to avoid double slashes with base URL or empty bucket names
        if (customPath.startsWith('/')) {
            customPath = customPath.substring(1)
        }
    } else {
        customPath = ''
    }

    const errs: string[] = []
    const urls = Array<ImgItem>()
    // 需要登记到 folders 表的目录（去重）
    const foldersToRegister = new Set<string>()
    for (let idx = 0; idx < images.length; idx++) {
        const item = images[idx]
        if (typeof item === 'string') continue
        const file = item as File
        const fileType = file.type
        // checkFileType is now async and needs DB
        if (!await checkFileType(fileType, c.env.DB)) {
            errs.push(`${fileType} not support.`)
            continue
        }

        // 解析文件自带的相对目录（文件夹上传），自动并入目标路径
        const relFolder = sanitizeRelativeFolder(relativePaths[idx])
        const targetPath = customPath + relFolder
        if (relFolder && user) {
            foldersToRegister.add(targetPath)
        }
        const delToken = crypto.randomUUID()
        const time = new Date().getTime()

        let filename = ''
        const originalName = file.name
        if (keepName && file.name) {
            // Sanitize filename: replace non-alphanumeric chars (except ._- and Chinese) with _
            // This ensures compatibility with R2 keys and URLs
            // Note: Hyphen must be at the end of character class to avoid creating unintended ranges
            const safeName = file.name.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_')
            console.log(`KeepName: ${keepName}, Original: ${file.name}, SafeData: ${safeName}`)
            if (safeName) {
                filename = safeName
            }
        }

        // Fallback or default filename generation
        if (!filename) {
            filename = await getFileName(fileType, time, c.env.DB)
        }

        const fullPath = targetPath + filename

        // If keeping original name, check if file already exists to prevent overwrite
        if (keepName) {
            const existing = await storage.head(fullPath)
            if (existing) {
                errs.push(`${file.name}: File already exists`)
                continue
            }
        }

        const metadata: Record<string, string> = {}
        metadata['delToken'] = delToken
        // 记录原始文件名称
        if (!keepName && originalName) {
            metadata['originalName'] = originalName
        }
        if (expireAt) {
            metadata['expires'] = expireAt.toString()
        }

        // Securely attach User Info to metadata
        if (user) {
            metadata['uploaderId'] = user.id.toString()
            metadata['uploadedBy'] = user.login
            // Store full name if available, handle potential unicode
            if (user.name) {
                metadata['uploaderName'] = encodeURIComponent(user.name)
            }
        }

        const object = await storage.put(fullPath, file.stream(), {
            contentType: fileType,
            metadata: metadata
        })

        if (object && object.key) {
            const finalSize = object.size || file.size
            // 存储删除token
            await c.env.XK.put(`del:${delToken}`, object.key)

            // 同步图片信息到 D1 数据库
            if (user) {
                console.log(`[Upload] Syncing to DB - key: ${object.key}, user_login: ${user.login}`)
                const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null
                c.executionCtx.waitUntil(
                    c.env.DB.prepare(
                        `INSERT INTO images (key, user_id, user_login, original_name, size, mime_type, folder, expires_at, storage_type, tags, nsfw, nsfw_score) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).bind(
                        object.key,
                        null,  // user_id 设为 null，避免外键约束失败（JWT 中的 id 是 GitHub ID）
                        user.login,
                        originalName || null,
                        finalSize,
                        fileType,
                        targetPath || '',
                        expireAt ? new Date(parseInt(expireAt.toString())).toISOString() : null,
                        storageType,
                        tagsJson,
                        nsfw,
                        nsfwScore
                    ).run().then((result) => {
                        console.log(`[Upload] Image inserted to DB successfully - key: ${object.key}, meta: ${JSON.stringify(result.meta)}`)
                        // 更新用户统计
                        return c.env.DB.prepare(
                            `UPDATE users SET 
                                storage_used = storage_used + ?, 
                                upload_count = upload_count + 1 
                             WHERE login = ?`
                        ).bind(finalSize, user.login).run()
                    }).then((result) => {
                        console.log(`[Upload] User stats updated - login: ${user.login}, meta: ${JSON.stringify(result.meta)}`)
                        // 记录上传审计日志
                        return c.env.DB.prepare(
                            `INSERT INTO audit_logs (user_id, user_login, action, target_key, details) 
                             VALUES (?, ?, 'upload', ?, ?)`
                        ).bind(user.id, user.login, object.key, JSON.stringify({ size: finalSize, originalName: originalName, storageType })).run()
                    }).then(() => {
                        // 大体积 jpeg/png 原图自动生成 webp 变体（此时 DB 已入库，转换请求可命中）
                        if (storageType === 'R2' && !skipVariants && shouldGenerateVariants(fileType, object.key, finalSize)) {
                            return generateVariants(c, object.key, { userLogin: user!.login })
                                .then(r => {
                                    if (r.error) console.warn(`[Upload] Variants partial - key: ${object.key}, ${r.error}`)
                                    else if (r.thumbKey || r.hdKey) console.log(`[Upload] Variants generated - key: ${object.key}`)
                                })
                                .catch(e => console.error(`[Upload] Variant generation failed - key: ${object.key}`, e))
                        }
                    }).catch(e => {
                        console.error(`[Upload] Failed to sync image to DB - key: ${object.key}, error:`, e)
                    })

                )

                // Sync to Album if specified
                if (albumId) {
                    c.executionCtx.waitUntil(
                        (async () => {
                            // Verify ownership (can be cached or lightweight)
                            // We do this check inside waitUntil to not block response, 
                            // but ideally we should verify before uploading if strict. 
                            // For UX speed, we do it here. If invalid, it just won't associate.
                            const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ? AND user_id = ?')
                                .bind(albumId, user.id).first()

                            if (album) {
                                await c.env.DB.prepare(
                                    `INSERT OR IGNORE INTO album_images (album_id, image_key, image_url, added_at) VALUES (?, ?, ?, ?)`
                                ).bind(album.id, object.key, storage.getPublicUrl(object.key), time).run()

                                // Update album updated_at
                                await c.env.DB.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').bind(time, album.id).run()
                                console.log(`[Upload] Linked image ${object.key} to album ${album.id}`)
                            }
                        })()
                    )
                }
            } else {
                console.log(`[Upload] No user context, skipping DB sync - key: ${object.key}`)
            }

            urls.push({
                key: object.key,
                size: finalSize,
                url: rewriteImageOrigin(storage.getPublicUrl(object.key), c.req.url),
                filename: file.name,
                delToken: delToken,
                storageType: storageType as 'R2' | 'HF',
                nsfw: nsfw === 1,
                nsfwScore: nsfwScore
            })
        }
    }

    // 文件夹上传时自动登记目录记录（含各级祖先），使目录导航实时可见；
    // 同时兼容旧表缺失的情况，失败不影响上传结果。
    if (foldersToRegister.size > 0 && user) {
        c.executionCtx.waitUntil((async () => {
            try {
                for (const path of foldersToRegister) {
                    await ensureFolderRecords(c.env.DB, user.login, path)
                }
            } catch (e) {
                console.error('[Upload] Failed to register folders:', e)
            }
        })())
    }

    return c.json(Build(urls, errs.toString()))
})

export default uploadRoutes
