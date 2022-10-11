// @ts-check
import path from 'path'
import ts from 'rollup-plugin-typescript2'
import replace from '@rollup/plugin-replace'
import json from '@rollup/plugin-json'

// 如果目标子包不存在则报错
if (!process.env.TARGET) {
  throw new Error('TARGET package must be specified via --environment flag.')
}

// 主包的版本号
const masterVersion = require('./package.json').version
// 子包存放的目录
const packagesDir = path.resolve(__dirname, 'packages')
// 获取将要打包的子包的目录
const packageDir = path.resolve(packagesDir, process.env.TARGET)
// 自定义 resolve 函数
const resolve = p => path.resolve(packageDir, p)
// 获取将要打包的子包的 package.json 文件内容
const pkg = require(resolve(`package.json`))
// 获取子包的构建选项
const packageOptions = pkg.buildOptions || {}
// 输出的文件名
const name = packageOptions.filename || path.basename(packageDir)

// ensure TS checks only once for each build
let hasTSChecked = false

const outputConfigs = {
  'esm-bundler': {
    file: resolve(`dist/${name}.esm-bundler.js`),
    format: `es`
  },
  'esm-browser': {
    file: resolve(`dist/${name}.esm-browser.js`),
    format: `es`
  },
  cjs: {
    file: resolve(`dist/${name}.cjs.js`),
    format: `cjs`
  },
  global: {
    file: resolve(`dist/${name}.global.js`),
    format: `iife`
  },
  // runtime-only builds, for main "vue" package only
  'esm-bundler-runtime': {
    file: resolve(`dist/${name}.runtime.esm-bundler.js`),
    format: `es`
  },
  'esm-browser-runtime': {
    file: resolve(`dist/${name}.runtime.esm-browser.js`),
    format: 'es'
  },
  'global-runtime': {
    file: resolve(`dist/${name}.runtime.global.js`),
    format: 'iife'
  }
}
// 默认打包输出格式
const defaultFormats = ['esm-bundler', 'cjs']
// 命令行参数传进来的打包输出格式
const inlineFormats = process.env.FORMATS && process.env.FORMATS.split(',')
// 在子包 package.json 中的构建选项中定义的打包输出格式
const packageFormats = inlineFormats || packageOptions.formats || defaultFormats
// rollup 打包的配置项
const packageConfigs = process.env.PROD_ONLY
  ? []
  : packageFormats.map(format => createConfig(format, outputConfigs[format]))

if (process.env.NODE_ENV === 'production') {
  packageFormats.forEach(format => {
    if (packageOptions.prod === false) {
      return
    }
    if (format === 'cjs') {
      packageConfigs.push(createProductionConfig(format))
    }
    if (/^(global|esm-browser)(-runtime)?/.test(format)) {
      packageConfigs.push(createMinifiedConfig(format))
    }
  })
}

export default packageConfigs

function createConfig(format, output, plugins = []) {
  // 如果没有输出格式则退出打包
  if (!output) {
    console.log(require('chalk').yellow(`invalid format: "${format}"`))
    process.exit(1)
  }

  // 是否是生产环境构建
  const isProductionBuild =
    process.env.__DEV__ === 'false' || /\.prod\.js$/.test(output.file)
  // 是 esm-bundler 构建
  const isBundlerESMBuild = /esm-bundler/.test(format)
  // 是 esm-browser 构建
  const isBrowserESMBuild = /esm-browser/.test(format)
  // 是服务端渲染
  const isServerRenderer = name === 'server-renderer'
  // 是否是 node 端构建
  const isNodeBuild = format === 'cjs'
  // 是否是 global 构建
  const isGlobalBuild = /global/.test(format)
  // 是否是 vue-compat 子包打包
  const isCompatPackage = pkg.name === '@vue/compat'
  // 是否是兼容性打包
  const isCompatBuild = !!packageOptions.compat

  output.exports = isCompatPackage ? 'auto' : 'named'
  output.sourcemap = !!process.env.SOURCE_MAP
  /**
   * 参考: https://rollupjs.org/guide/en/#outputexternallivebindings
   * 给 output 变量设置 externalLiveBindings 属性，默认值（true）
   * 当设置为false时，Rollup不会生成代码来支持外部导入的模块(假设导出的模块不会随时间而改变的前提下)。
   * 这将允许Rollup生成更优化的代码。请注意，当存在涉及外部依赖项的循环依赖项时，这可能会导致问题。
   * 这将避免大多数情况下Rollup在代码中生成getter，因此在许多情况下可用于使代码IE8兼容。
   */
  output.externalLiveBindings = false
  /**
   * 全局打包时，读取模块下 package.json 文件 中设定的 buildOptions 属性中的name属性赋值给output.name
   */
  if (isGlobalBuild) {
    output.name = packageOptions.name
  }
  // 判断是否生成 .d.ts 和 .d.ts.map 文件
  const shouldEmitDeclarations =
    pkg.types && process.env.TYPES != null && !hasTSChecked

  const tsPlugin = ts({
    // check: 设置为false可避免对代码进行任何诊断检查。
    check: process.env.NODE_ENV === 'production' && !hasTSChecked,
    /**
     * tsconfig的路径.json。如果您的tsconfig在项目目录中有其他名称或相对位置，请设置此选项。
     * 默认情况下，将尝试加载/tsconfig.json，但如果文件丢失，则不会失败，除非明确设置该值。
     */
    tsconfig: path.resolve(__dirname, 'tsconfig.json'),
    /* 缓存的路径。默认为node_modules目录下的一个的文件夹 */
    cacheRoot: path.resolve(__dirname, 'node_modules/.rts2_cache'),
    tsconfigOverride: {
      compilerOptions: {
        target: isServerRenderer || isNodeBuild ? 'es2019' : 'es2015',
        sourceMap: output.sourcemap,
        // 为项目中TypeScript和JavaScript生成.d.ts文件
        declaration: shouldEmitDeclarations,
        /**
         * 开启 --declarationMap ，编译器会同时生成 .d.ts 和 .d.ts.map 文件。
         * 语言服务现在能够正确识别这些映射文件，并且使用它们来映射到源码。
         * 也就是说，在使用“跳到定义之处”功能时，会直接跳转到源码文件，而不是 .d.ts 文件。
         */
        declarationMap: shouldEmitDeclarations
      },
      // 指定解析 include 属性配置信息时，应该跳过的文件名称
      exclude: ['**/__tests__', 'test-dts']
    }
  })
  // we only need to check TS and generate declarations once for each build.
  // it also seems to run into weird issues when checking multiple times
  // during a single build.
  hasTSChecked = true
  // 定义模块入口文件
  let entryFile = /runtime$/.test(format) ? `src/runtime.ts` : `src/index.ts`

  // the compat build needs both default AND named exports. This will cause
  // Rollup to complain for non-ESM targets, so we use separate entries for
  // esm vs. non-esm builds.
  if (isCompatPackage && (isBrowserESMBuild || isBundlerESMBuild)) {
    entryFile = /runtime$/.test(format)
      ? `src/esm-runtime.ts`
      : `src/esm-index.ts`
  }

  let external = []

  if (isGlobalBuild || isBrowserESMBuild || isCompatPackage) {
    if (!packageOptions.enableNonBrowserBranches) {
      // normal browser builds - non-browser only imports are tree-shaken,
      // they are only listed here to suppress warnings.
      external = ['source-map', '@babel/parser', 'estree-walker']
    }
  } else {
    // Node / esm-bundler builds.
    // externalize all direct deps unless it's the compat build.
    external = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...['path', 'url', 'stream'] // for @vue/compiler-sfc / server-renderer
    ]
  }

  // we are bundling forked consolidate.js in compiler-sfc which dynamically
  // requires a ton of template engines which should be ignored.
  let cjsIgnores = []
  if (pkg.name === '@vue/compiler-sfc') {
    const consolidatePath = require.resolve('@vue/consolidate/package.json', {
      paths: [packageDir]
    })
    cjsIgnores = [
      ...Object.keys(require(consolidatePath).devDependencies),
      'vm',
      'crypto',
      'react-dom/server',
      'teacup/lib/express',
      'arc-templates/dist/es5',
      'then-pug',
      'then-jade'
    ]
  }

  const nodePlugins =
    (format === 'cjs' && Object.keys(pkg.devDependencies || {}).length) ||
    packageOptions.enableNonBrowserBranches
      ? [
          // @ts-ignore
          require('@rollup/plugin-commonjs')({
            sourceMap: false,
            ignore: cjsIgnores
          }),
          ...(format === 'cjs'
            ? []
            : // @ts-ignore
              [require('rollup-plugin-polyfill-node')()]),
          require('@rollup/plugin-node-resolve').nodeResolve()
        ]
      : []

  return {
    input: resolve(entryFile),
    // Global and Browser ESM builds inlines everything so that they can be
    // used alone.
    external,
    plugins: [
      json({
        namedExports: false
      }),
      tsPlugin,
      createReplacePlugin(
        isProductionBuild,
        isBundlerESMBuild,
        isBrowserESMBuild,
        // isBrowserBuild?
        (isGlobalBuild || isBrowserESMBuild || isBundlerESMBuild) &&
          !packageOptions.enableNonBrowserBranches,
        isGlobalBuild,
        isNodeBuild,
        isCompatBuild,
        isServerRenderer
      ),
      ...nodePlugins,
      ...plugins
    ],
    output,
    // 拦截警告消息.如果未配置，警告信息将被去重并打印到控制台。
    onwarn: (msg, warn) => {
      if (!/Circular/.test(msg)) {
        warn(msg)
      }
    },
    treeshake: {
      // 如果引入的模块代码想要保留，至少需要有一个该模块元素被使用过。
      moduleSideEffects: false
    }
  }
}

function createReplacePlugin(
  isProduction,
  isBundlerESMBuild,
  isBrowserESMBuild,
  isBrowserBuild,
  isGlobalBuild,
  isNodeBuild,
  isCompatBuild,
  isServerRenderer
) {
  const replacements = {
    __COMMIT__: `"${process.env.COMMIT}"`,
    __VERSION__: `"${masterVersion}"`,
    __DEV__: isBundlerESMBuild
      ? // preserve to be handled by bundlers
        `(process.env.NODE_ENV !== 'production')`
      : // hard coded dev/prod builds
        !isProduction,
    // this is only used during Vue's internal tests
    __TEST__: false,
    // If the build is expected to run directly in the browser (global / esm builds)
    __BROWSER__: isBrowserBuild,
    __GLOBAL__: isGlobalBuild,
    __ESM_BUNDLER__: isBundlerESMBuild,
    __ESM_BROWSER__: isBrowserESMBuild,
    // is targeting Node (SSR)?
    __NODE_JS__: isNodeBuild,
    // need SSR-specific branches?
    __SSR__: isNodeBuild || isBundlerESMBuild || isServerRenderer,

    // for compiler-sfc browser build inlined deps
    ...(isBrowserESMBuild
      ? {
          'process.env': '({})',
          'process.platform': '""',
          'process.stdout': 'null'
        }
      : {}),

    // 2.x compat build
    __COMPAT__: isCompatBuild,

    // feature flags
    __FEATURE_SUSPENSE__: true,
    __FEATURE_OPTIONS_API__: isBundlerESMBuild ? `__VUE_OPTIONS_API__` : true,
    __FEATURE_PROD_DEVTOOLS__: isBundlerESMBuild
      ? `__VUE_PROD_DEVTOOLS__`
      : false,
    ...(isProduction && isBrowserBuild
      ? {
          'context.onError(': `/*#__PURE__*/ context.onError(`,
          'emitError(': `/*#__PURE__*/ emitError(`,
          'createCompilerError(': `/*#__PURE__*/ createCompilerError(`,
          'createDOMCompilerError(': `/*#__PURE__*/ createDOMCompilerError(`
        }
      : {})
  }
  // allow inline overrides like
  //__RUNTIME_COMPILE__=true yarn build runtime-core
  Object.keys(replacements).forEach(key => {
    if (key in process.env) {
      replacements[key] = process.env[key]
    }
  })
  return replace({
    // @ts-ignore
    values: replacements,
    preventAssignment: true
  })
}

function createProductionConfig(format) {
  return createConfig(format, {
    file: resolve(`dist/${name}.${format}.prod.js`),
    format: outputConfigs[format].format
  })
}

function createMinifiedConfig(format) {
  const { terser } = require('rollup-plugin-terser')
  return createConfig(
    format,
    {
      file: outputConfigs[format].file.replace(/\.js$/, '.prod.js'),
      format: outputConfigs[format].format
    },
    [
      terser({
        module: /^esm/.test(format),  // true is set when format is esm or es
        compress: {
          ecma: 2015,
          pure_getters: true
        },
        safari10: true
      })
    ]
  )
}
