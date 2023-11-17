import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { readFile } from 'fs/promises'
import { context } from 'esbuild'
import { Loro } from 'loro-crdt'

const doc = new Loro

const binwrite = (res: ServerResponse, buffer: Uint8Array) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
  return res.end(buffer)
}

const binread = (req: IncomingMessage) => new Promise<Uint8Array>((resolve, reject) => {
  const chunks: Uint8Array[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

const ctx = await context({
  entryPoints: ['main.ts'],
  bundle: true,
  format: 'esm',
  outdir: '.',
  write: false,
  sourcemap: true,
  plugins: [{
    name: 'wasm',
    setup({ onResolve, onLoad }) {
      onResolve({ filter: /\.wasm$/ }, args => {
        if (args.namespace === 'wasm-stub') {
          return {
            path: args.path,
            namespace: 'wasm-binary'
          }
        }

        if (args.resolveDir === '') {
          return
        }
        return {
          path: isAbsolute(args.path) ? args.path : join(args.resolveDir, args.path),
          namespace: 'wasm-stub',
          pluginData: args.resolveDir
        }
      })

      async function parseWasm(path: string) {
        const binary = await readFile(path)
        const module = await WebAssembly.compile(binary)
        const imports: { [from: string]: string[] } = Object.create(null)
        WebAssembly.Module.imports(module).forEach(({ module, name }) =>
          (imports[module] ||= []).push(name))
        const exports = WebAssembly.Module.exports(module).map(({ name }) => name)
        return { imports: Object.entries(imports), exports }
      }

      onLoad({ filter: /(?:)/, namespace: 'wasm-stub' }, async args => {
        const { imports, exports } = await parseWasm(args.path)
        const codes: string[] = []
        imports.forEach(([from, names], i) => {
          codes.push(`import { ${names.map((name, j) => `${name} as __wasmImport_${i}_${j}`).join(', ')} } from ${JSON.stringify(from)}`)
        })
        codes.push(`import wasm from ${JSON.stringify(args.path)}`)
        codes.push(`const __wasmModule = (await WebAssembly.instantiate(wasm, {
          ${imports.map(([from, names], i) => `${JSON.stringify(from)}: {
            ${names.map((name, j) => `${name}: __wasmImport_${i}_${j}`).join(', ')}
          }`).join(', ')}
        })).instance.exports`)
        exports.forEach(name => {
          codes.push(`export ${name === 'default' ? 'default' : `const ${name} =`} __wasmModule.${name}`)
        })
        return {
          contents: codes.join('\n'),
          resolveDir: args.pluginData
        }
      })

      onLoad({ filter: /(?:)/, namespace: 'wasm-binary' }, async args => ({
        contents: await readFile(args.path),
        loader: 'binary'
      }))
    }
  }]
})

await ctx.serve({ servedir: '.' })

const server = createServer(async (req, res) => {
  // TODO: handle errors more gracefully
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('loro-crdt server\nGET /snapshot\nGET /partial?<base64 version>\n')
  }

  if (req.method === 'GET' && req.url === '/snapshot') {
    return binwrite(res, doc.exportSnapshot())
  }

  // now you can poll for changes
  // TODO: websocket
  if (req.method === 'GET' && req.url && req.url.startsWith('/partial')) {
    const index = req.url.indexOf('?', 1)
    const base64 = index >= 0 && req.url.slice(index + 1)
    const version = base64 ? Buffer.from(base64, 'base64url') : void 0
    let data: Uint8Array
    try {
      data = doc.exportFrom(version)
    } catch {
      data = doc.exportFrom()
      console.log('POST /partial: invalid version', base64)
    }
    return binwrite(res, data)
  }

  // publish client updates here
  if (req.method === 'POST' && req.url === '/commit') {
    doc.import(await binread(req))
    // TODO: notify connected clients to fetch new partial, or push websocket update
    res.statusCode = 201
    return res.end()
  }

  res.statusCode = 404
  res.end()
})

server.listen(3000, () => console.log('serving http://localhost:8000 (html) and http://localhost:3000 (api)'))
