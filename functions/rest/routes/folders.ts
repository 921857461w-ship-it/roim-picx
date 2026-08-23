import { Hono } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'
import { Ok, Fail, Folder } from '../type'
import type { User } from '../type'
import { auth, type AppEnv } from '../middleware/auth'
import { getProviderByType } from '../storage'

const folderRoutes = new Hono<AppEnv>()

// 目录名合法字符：字母、数字、下划线、连字符和中文
const FOLDER_NAME_REGX = /^[A-Za-z0-9_-\u4e00-\u9fa5]+$/

/**
 * 将目录路径（含各级祖先目录）写入 folders 表，保证目录导航能展示空目录。
 * path 形如 'a/b/c/'，会同时插入 'a/'、'a/b/'、'a/b/c/'。
 */
export async function ensureFolderRecords(db: D1Database, userLogin: string, path: string): Promise<void> {
    if (!path || path === '/') return
    const normalized = path.endsWith('/') ? path : path + '/'
    const segments = normalized.split('/').filter(Boolean)
    let current = ''
    for (const seg of segments) {
        current += seg + '/'
        await db.prepare('INSERT OR IGNORE INTO folders (path, user_login) VALUES (?, ?)')
            .bind(current, userLogin).run()
    }
}

// 创建目录（支持在指定父目录下创建，同步写入 D1 以便目录导航实时展示）
folderRoutes.post("/folder", auth, async (c) => {
    const user = c.get('user') as User | undefined
    const isAdminToken = c.get('isAdminToken') || false
    if (!user && !isAdminToken) {
        return c.json(Fail('未授权'))
    }
    const userLogin = user?.login || 'admin'

    try {
        const data = await c.req.json<Folder>()
        // Allow letters, numbers, underscores, hyphens and Chinese
        if (!data.name || !FOLDER_NAME_REGX.test(data.name)) {
            return c.json(Fail("Folder name error: only letters, numbers, underscores, hyphens and Chinese allowed"))
        }

        // 校验父目录路径
        let parent = (data.parent || '').replace(/^\/+/, '')
        if (parent) {
            if (!parent.endsWith('/')) parent += '/'
            const segments = parent.split('/').filter(Boolean)
            if (segments.length === 0 || !segments.every(seg => FOLDER_NAME_REGX.test(seg))) {
                return c.json(Fail("Invalid parent folder path"))
            }
            parent = segments.join('/') + '/'
        }

        const fullPath = parent + data.name + '/'
        await c.env.PICX.put(fullPath, null)

        // 同步写入 D1（含祖先目录），保证前端刷新后立即可见；
        // 若 folders 表尚未迁移，则降级为仅 R2 占位，不影响创建。
        try {
            await ensureFolderRecords(c.env.DB, userLogin, fullPath)
        } catch (e) {
            console.error('Failed to register folder in DB:', e)
        }

        return c.json(Ok({ path: fullPath }))
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

        // 4.5 清理 folders 表中的目录记录（含子目录）
        try {
            await c.env.DB.prepare('DELETE FROM folders WHERE path = ? OR path LIKE ?')
                .bind(folder, folder + '%').run()
        } catch (e) {
            console.error('[folder-delete] Failed to delete folder records:', e)
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
