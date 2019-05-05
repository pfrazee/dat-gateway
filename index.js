'use strict'

const Dat = require('dat-node')
const http = require('http')
const hyperdriveHttp = require('hyperdrive-http')
const LRU = require('lru-cache')
const resolveDat = require('dat-link-resolve')

function log () {
  let msg = arguments[0]
  arguments[0] = '[dat-gateway] ' + msg
  if (process.env.DEBUG || process.env.LOG) {
    console.log.apply(console, arguments)
  }
}

var map = {}

module.exports =
class DatGateway {
  constructor ({ dir, max, maxAge }) {
    this.dir = dir
    this.datOptions = { temp: true }
    log('Starting gateway at %s with options %j', this.dir, { max, maxAge })
    this.cache = new LRU({
      dispose: function (key, dat) {
        log('Disposing of archive %s', key)
        dat.close()
      },
      max,
      maxAge
    })
    this.server = http.createServer((req, res) => {
      log('%s %s', req.method, req.url)
      let subdomain = req.headers.host.split('.')[0]
      let urlParts = req.url.split('/')
      if (subdomain === 'dat') {
        let requestedDat = urlParts[1]
        let shortname = requestedDat.substr(0,5)
        map[shortname] = requestedDat 
        let protocol = (req.connection.encrypted) ? 'https' : 'http'
        let redirectTo = `${protocol}://${req.headers.host.replace('dat', shortname)}`
        res.writeHead(302, {
           location: `${redirectTo}`
        })
        return res.end();
      }
      let address = map[subdomain]
      let path = urlParts.slice(1).join('/')
      return this.resolveDat(address).then((key) => {
        return this.getDat(key)
      }).then((dat) => {
        // handle it!!
        req.url = `/${path}`
        dat.onrequest(req, res)
      }).catch((e) => {
        log(e)
        if (e.message === 'DNS record not found') {
          res.writeHead(404)
          res.end('Not found')
        } else {
          res.writeHead(500)
          res.end(JSON.stringify(e))
        }
      })
    })
  }

  listen (port, host) {
    return new Promise((resolve, reject) => {
      this.server.listen(port, host, (err) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  close () {
    return new Promise((resolve) => {
      this.server.close(resolve)
    }).then(() => {
      this.cache.reset()
    })
  }

  getDat (key) {
    // check local cache
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key))
    // retrieve from the web
    return new Promise((resolve, reject) => {
      const opts = Object.assign({}, this.datOptions, { key })
      Dat(this.dir, opts, (err, dat) => {
        if (err) {
          return reject(err)
        } else {
          this.cache.set(key, dat)
          dat.joinNetwork()
          dat.onrequest = hyperdriveHttp(dat.archive, { live: true, exposeHeaders: true })
          dat.archive.metadata.update(() => {
            resolve(dat)
          })
        }
      })
    })
  }

  resolveDat (address) {
    return new Promise((resolve, reject) => {
      resolveDat(address, (err, key) => {
        if (err) {
          return reject(err)
        } else {
          return resolve(key)
        }
      })
    })
  }
}
