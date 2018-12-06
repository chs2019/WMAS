const Route = require('../../data/route')
const Session = require('../../data/session')
const ApiHandler = require('./api-handler')

class TestApiHandler extends ApiHandler {
  constructor ({
    wavePort,
    wptPort,
    wptSslPort,
    resultsManager,
    sessionManager
  }) {
    super()
    this._routes = this._createRoutes()
    this._wptPort = wptPort
    this._wptSslPort = wptSslPort
    this._wavePort = wavePort
    this._resultsManager = resultsManager
    this._sessionManager = sessionManager
  }

  _createRoutes () {
    return [
      new Route('/next', this._handleRequest.bind(this)),
      new Route('/next/*', this._handleRequest.bind(this))
    ]
  }

  getRoutes () {
    return this._routes
  }

  _handleRequest (request, response) {
    const method = request.method
    switch (method) {
      case 'GET':
        return this._nextTest({ request, response })
    }
    response.status(404).send()
  }

  async _nextTest ({ request, response }) {
    const userAgent = request.get('User-Agent')
    let { token } = this.parseQueryParameters(request)
    if (!token) {
      token = request.get('token')
    }
    if (!token || token === 'null') {
      token = request.cookies.sid
    }

    const { path, reftoken, types, testTimeout, hostname } = this.parseQueryParameters(
      request
    )

    let session = await this._sessionManager.getSession(token)
    if (!session || session.getStatus() === Session.COMPLETED || path) {
      session = await this._sessionManager.createSession({
        path,
        reftoken,
        types,
        userAgent,
        testTimeout
      })

      const token = session.getToken()

      // save token in cookie to resume session if tests run into problems
      response.cookie('sid', token, {
        maxAge: 1000 * 60 * 60 * 48, // 2 days
        httpOnly: true,
      })

      let query = '?token=' + token
      response.send(
        this._generateUrl({
          hostname,
          port: this._wavePort,
          uri: '/newsession.html',
          query,
        })
      )
      return
    }

    if (request.query.resume) {
      let query = '?token=' + token + '&resume=1'
      response.send(
        this._generateUrl({
          hostname,
          port: this._wavePort,
          uri: '/newsession.html',
          query,
        })
      )
      return
    }

    switch (session.getStatus()) {
      case Session.PAUSED: {
        let query = '?token=' + session.getToken()
        response.send(
          this._generateUrl({
            hostname,
            uri: '/pause.html',
            port: this._wavePort,
            query
          })
        )
        return
      }
      case Session.ABORTED: {
        let query = '?token=' + session.getToken()
        response.send(
          this._generateUrl({
            hostname,
            uri: '/complete.html',
            port: this._wavePort,
            query
          })
        )
        return
      }
    }

    let test = session.nextTest(this._onTestTimeout.bind(this))

    console.log('TEST', test)
    if (!test) {
      if (session.getStatus() === Session.RUNNING) {
        let query = '?token=' + session.getToken()
        const url = this._generateUrl({
          hostname,
          uri: '/complete.html',
          port: this._wavePort,
          query
        })

        if (request.query.redirect) {
          response.redirect(url)
        } else {
          response.send(url)
        }
        session.setStatus(Session.COMPLETED)
        await this._sessionManager.updateSession(session)
      }
      return
    }

    // console.log('TEST', test)

    const url = this._generateTestUrl({
      test,
      token: session.getToken(),
      testTimeout: session.getTestTimeout(),
      hostname
    })

    if (request.query.redirect) {
      response.redirect(url)
    } else {
      response.send(url)
    }
    await this._sessionManager.updateSession(session)
  }

  _generateTestUrl ({ hostname, test, token, testTimeout }) {
    let protocol = 'http'
    let port = this._wptPort

    if (test.indexOf('https') !== -1) {
      protocol = 'https'
      port = this._wptSslPort
    }

    let query = '?'
    query += '&token=' + token
    query += '&timeout=' + testTimeout

    return this._generateUrl({ protocol, hostname, port, uri: test, query })
  }

  _generateUrl ({ protocol, hostname, port, uri, query }) {
    protocol = protocol || 'http'
    port = port || 80
    uri = uri || '/'
    if (!uri.startsWith('/')) uri = '/' + uri
    query = query || ''
    return protocol + '://' + hostname + ':' + port + uri + query
  }

  _onTestTimeout (token, test) {
    console.log('TIMEOUT', test)
    this._resultsManager
      .saveResult({
        token,
        test,
        result: {
          test,
          status: 'TIMEOUT',
          message: null,
          subtests: [{
            status: 'TIMEOUT',
            xstatus: 'SERVERTIMEOUT',
          }],
        }
      })
      .catch(error => console.error(error))
  }
}

module.exports = TestApiHandler
