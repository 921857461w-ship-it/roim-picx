import { Hono } from 'hono'
import { Ok, Fail, Folder } from '../type'
import type { User } from '../type'
import { auth, type AppEnv } from '../middleware/auth'
import { getProviderByType } from '../storage'

const folderRoutes = new Hono<AppEnv>()

// 创建目录
folderRoutes.post("/folder", auth, async (c) => {
    try {
        const data = await c.req.json<Folder>()
        // Allow letters, numbers, underscores, hyphens and Chinese
        const regx = /^[A-Za-z0-9_-\u4e00-\u9fa5]+$/
        if (!data.name || !regx.test(data.name)) {
            return c.json(Fail("Folder name error: only letters, numbers, underscores, hyphens and Chinese allowed"))
        }
        await c.env.PICX.put(data.name + '/', null)
        return c.json(Ok("Success"))
    } catch (e) {
        console.error('Create folder error:', e)
        return c.json(Fail(`Create folder fail: ${(e as Error).message}`))
    }
})

/**
 * 删除文件夹（含其中所有图片）
 * - 同步删除 D1 残留记录（解决在 R2 控制台直接删除后前端仍显示的问题）
 * - 尽力删除物理存储中的文件（已不存在时自动跳过）
 * - 非管理员只能删除自己上传的图片；管理员删除全部
 */
folderRoutes.post("/folder/delete", auth, async (c) => {
    const user = c.get('user') as User | undefined
    const isAdminToken = c.get('isAdminToken') || false
    const isAdmin = isAdminToken || user?.role === 'admin'

    if (!user && !isAdminToken) {
        return c.json(Fail('未授权'))
    }

    try {
        const data = await c.req.json<{ folder: string }>()
        let folder = (data.folder || '').trim()
        if (!folder || folder === '/') {
            return c.json(Fail('无效的文件夹'))
        }
        if (!folder.endsWith('/')) {
            folder += '/'
        }

        // 查询该文件夹（含子文件夹）下的所有图片记录
        const query = isAdmin
            ? 'SELECT key, size, user_login, storage_type FROM images WHERE folder = ? OR folder LIKE ?'
            : 'SELECT key, size, user_login, storage_type FROM images WHERE user_login = ? AND (folder = ? OR folder LIKE ?)'
        const params = isAdmin
            ? [folder, folder + '%']
            : [user!.login, folder, folder + '%']

        const result = await c.env.DB.prepare(query).bind(...params).all<{
            key: string, size: number, user_login: string, storage_type: 'R2' | 'HF'
        }>()
        const images = result.results || []

        // 1. 尽力删除物理文件（R2/HF 中已被手动删除的会自动跳过）
        for (const img of images) {
            try {
                const provider = getProviderByType(c, img.storage_type || 'R2')
                await provider.delete(img.key)
            } catch (e) {
                console.error(`[folder-delete] Failed to delete object ${img.key}:`, e)
            }
        }

        // 2. 分批删除 D1 记录
        const CHUNK = 500
        for (let i = 0; i < images.length; i += CHUNK) {
            const chunk = images.slice(i, i + CHUNK)
            const placeholders = chunk.map(() => '?').join(',')
            await c.env.DB.prepare(`DELETE FROM images WHERE key IN (${placeholders})`)
                .bind(...chunk.map(it => it.key)).run()
        }

        // 3. 回滚各用户的已用存储统计
        const sizeByUser = new Map<string, number>()
        for (const img of images) {
            sizeByUser.set(img.user_login, (sizeByUser.get(img.user_login) || 0) + (img.size || 0))
        }
        for (const [login, size] of sizeByUser) {
            await c.env.DB.prepare(
                'UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE login = ?'
            ).bind(size, login).run()
        }

        // 4. 尽力删除 R2 中的文件夹占位对象（创建目录时写入的 name/）
        try {
            await c.env.PICX.delete(folder)
        } catch (e) {
            console.error('[folder-delete] Failed to delete placeholder:', e)
        }

        // 5. 审计日志
        if (user) {
            c.executionCtx.waitUntil(
                c.env.DB.prepare(
                    `INSERT INTO audit_logs (user_id, user_login, action, target_key, details)
                     VALUES (?, ?, 'delete_folder', ?, ?)`
                ).bind(user.id, user.login, folder, JSON.stringify({ imageCount: images.length }))
                    .run().catch(e => console.error('Failed to log folder delete:', e))
            )
        }

        return c.json(Ok({ folder, deletedImages: images.length }))
    } catch (e) {
        console.error('Delete folder error:', e)
        return c.json(Fail(`Delete folder fail: ${(e as Error).message}`))
    }
})

export default folderRoutes
