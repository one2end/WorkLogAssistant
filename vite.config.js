import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      // 15 分钟吸附规则只有一份实现，主进程与渲染层共用同一个文件。
      // 复制一份到 src/ 是更省事的做法，但那会让「预览说 105 分、实际存 90 分」
      // 这种偏差无从察觉——两份代码各自演化，谁也不会报错。
      '@slot-rule': path.resolve(__dirname, 'electron/slotRule.js')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // slotRule.js 用 module.exports 导出，Rollup 默认只认 ESM。
    // 打开 commonjs 转换才能把它作为模块引入，而不是再抄一份到 src/。
    commonjsOptions: {
      include: [/electron\/slotRule\.js/, /node_modules/]
    }
  },
  optimizeDeps: {
    include: ['@slot-rule']
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
