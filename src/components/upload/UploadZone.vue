<template>
    <div class="relative group">
        <div class="border-2 border-dashed rounded-3xl p-12 text-center transition-all duration-300 cursor-pointer min-h-[340px] flex flex-col items-center justify-center bg-white dark:bg-gray-800"
            :class="isDragging ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/10' : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400 dark:hover:border-indigo-500 hover:bg-gray-50 dark:hover:bg-gray-700/50'"
            @drop.prevent="onFileDrop" @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false"
            @click="convertedImages.length === 0 ? input?.click() : null">
            <input type="file" ref="input" multiple accept="image/*" class="hidden" @change="onInputChange" />
            <input type="file" ref="folderInput" multiple webkitdirectory class="hidden" @change="onFolderInputChange" />

            <template v-if="convertedImages.length === 0">
                <div
                    class="w-20 h-20 mb-6 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <font-awesome-icon :icon="faCloudUploadAlt" class="text-4xl" />
                </div>
                <h2 class="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">{{ $t('upload.dropzone')
                    }}</h2>
                <p class="text-gray-500 dark:text-gray-400 max-w-xs mx-auto text-sm leading-relaxed">
                    {{ $t('upload.dropzoneHint') }}
                </p>
                <button type="button"
                    class="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
                    :title="$t('upload.uploadFolderHint')" @click.stop="folderInput?.click()">
                    <font-awesome-icon :icon="faFolderOpen" />
                    {{ $t('upload.uploadFolder') }}
                </button>
            </template>
            <template v-else>
                <transition-group name="el-fade-in-linear" tag="div"
                    class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 w-full">
                    <div v-for="item in convertedImages" :key="item.tmpSrc" class="relative group/item" @click.stop>
                        <image-box :src="item.tmpSrc" :size="item.file.size" :name="item.file.name"
                            @delete="$emit('remove-image', item.tmpSrc)" mode="converted"
                            class="w-full h-full shadow-sm rounded-xl overflow-hidden group-hover/item:shadow-md transition-shadow" />
                    </div>
                </transition-group>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { faCloudUploadAlt, faFolderOpen } from '@fortawesome/free-solid-svg-icons'
import ImageBox from '../ImageBox.vue'
import type { ConvertedImage, FileEntry } from '../../utils/types'

defineProps<{
    convertedImages: ConvertedImage[]
}>()

const emit = defineEmits<{
    (e: 'files-selected', entries: FileEntry[]): void
    (e: 'remove-image', tmpSrc: string): void
}>()

const isDragging = ref(false)
const input = ref<HTMLInputElement>()
const folderInput = ref<HTMLInputElement>()

const toEntries = (files: FileList | null | undefined): FileEntry[] => {
    if (!files) return []
    return Array.from(files).map(file => ({
        file,
        relativePath: file.webkitRelativePath || undefined
    }))
}

const onInputChange = () => {
    emit('files-selected', toEntries(input.value?.files))
}

const onFolderInputChange = () => {
    emit('files-selected', toEntries(folderInput.value?.files))
    // 重置以支持重复选择同一文件夹
    if (folderInput.value) folderInput.value.value = ''
}

// 递归遍历拖入的文件夹，保留相对路径以便上传时自动创建目录
type FsEntry = {
    isFile: boolean
    isDirectory: boolean
    name: string
    file: (success: (f: File) => void, error?: (e: unknown) => void) => void
    createReader?: () => { readEntries: (success: (entries: FsEntry[]) => void, error?: (e: unknown) => void) => void }
}

async function traverseEntry(entry: FsEntry, basePath: string, out: FileEntry[]): Promise<void> {
    if (entry.isFile) {
        try {
            const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject))
            out.push({ file, relativePath: basePath + file.name })
        } catch (e) {
            console.error('Failed to read dropped file:', e)
        }
    } else if (entry.isDirectory && entry.createReader) {
        const reader = entry.createReader()
        let batch: FsEntry[] = []
        do {
            batch = await new Promise<FsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
            for (const child of batch) {
                await traverseEntry(child, basePath + entry.name + '/', out)
            }
        } while (batch.length > 0)
    }
}

const onFileDrop = async (e: DragEvent) => {
    isDragging.value = false
    const items = e.dataTransfer?.items
    const entries: FsEntry[] = []
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const entry = (items[i] as any).webkitGetAsEntry?.() as FsEntry | null
            if (entry) entries.push(entry)
        }
    }
    // 支持文件夹拖拽：存在目录时递归遍历；否则退回普通文件列表
    if (entries.length > 0 && entries.some(en => en.isDirectory)) {
        const out: FileEntry[] = []
        for (const entry of entries) {
            await traverseEntry(entry, '', out)
        }
        emit('files-selected', out)
        return
    }
    if (entries.length > 0) {
        const out: FileEntry[] = []
        for (const entry of entries) {
            await traverseEntry(entry, '', out)
        }
        emit('files-selected', out)
        return
    }
    emit('files-selected', toEntries(e.dataTransfer?.files))
}
</script>
