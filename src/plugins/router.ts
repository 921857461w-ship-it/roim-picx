import { createRouter, createWebHistory } from 'vue-router'
import DefaultLayout from '../layouts/DefaultLayout.vue'
import BlankLayout from '../layouts/BlankLayout.vue'

const router = createRouter({
	history: createWebHistory(),
	routes: [
		{
			path: '/',
			component: DefaultLayout,
			children: [
				{
					// 首页绑定相册列表
					path: '',
					component: () => import('../components/album/AlbumList.vue'),
					meta: { requiresAuth: true }
				},
				{
					// 图片管理移至 /manage
					path: 'manage',
					component: () => import('../views/ManageImages.vue')
				},
				{
					path: 'up',
					component: () => import('../views/UploadImages.vue')
				},
				{
					path: 'admin',
					component: () => import('../views/AdminView.vue'),
					meta: { requiresAuth: true }
				},
				{
					path: 'shares',
					component: () => import('../views/MySharesView.vue')
				},
				{
					// 兼容旧路径：/albums 重定向到首页相册列表
					path: 'albums',
					redirect: '/'
				},
				{
					path: 'albums/:id',
					component: () => import('../components/album/AlbumDetail.vue'),
					meta: { requiresAuth: true }
				}
			]
		},
		{
			path: '/auth',
			component: BlankLayout,
			children: [
				{
					path: '',
					component: () => import('../views/auth.vue')
				}
			]
		},
		{
			path: '/delete/:token',
			component: BlankLayout,
			children: [
				{
					path: '',
					component: () => import('../views/DeleteImage.vue')
				}
			]
		},
		{
			path: '/s/:id',
			component: BlankLayout,
			children: [
				{
					path: '',
					component: () => import('../views/ShareView.vue'),
					meta: { public: true }
				}
			]
		},
		{
			path: '/s/album/:token',
			component: BlankLayout,
			children: [
				{
					path: '',
					component: () => import('../components/album/PublicAlbumView.vue'),
					meta: { public: true }
				}
			]
		},
		{
			path: '/:path(.*)',
			redirect: '/'
		}
	]
})

export default router
