import { Loro } from 'loro-crdt'
import { uint8ArrayToBase64 } from 'uint8array-extras'

// https://github.com/loro-dev/loro/issues/177
// const doc = await fetch('http://localhost:3000/snapshot')
//   .then(r => r.arrayBuffer())
//   .then(b => Loro.fromSnapshot(new Uint8Array(b)))

console.time('init')

const doc = new Loro
await fetch('http://localhost:3000/partial')
  .then(r => r.arrayBuffer())
  .then(b => doc.import(new Uint8Array(b)))
globalThis.doc = doc

console.timeEnd('init')

// TODO: use websocket
const pollInSeconds = 1
const poll = () => fetch('http://localhost:3000/partial?' + uint8ArrayToBase64(doc.version(), { urlSafe: true }))
  .then(r => r.arrayBuffer())
  .then(b => doc.import(new Uint8Array(b)))
  .then(() => setTimeout(poll, pollInSeconds * 1000))
poll()

let lastVersion = doc.version()
doc.subscribe((event) => {
  if (event.local) {
    fetch('http://localhost:3000/commit', {
      method: 'POST',
      body: doc.exportFrom(lastVersion)
    })
    lastVersion = doc.version()
  }
})
