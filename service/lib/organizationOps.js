'use strict'

const Boom = require('boom')
const async = require('async')
const dbUtil = require('./dbUtil')
const PolicyOps = require('./policyOps')
const SQL = dbUtil.SQL

module.exports = function (dbPool, log) {
  const policyOps = PolicyOps(dbPool)

  function insertOrganization (job, next) {
    const { id, name, description } = job.params
    const sqlQuery = SQL`
      INSERT INTO organizations (
        id, name, description
      )
      VALUES (
        ${id}, ${name}, ${description}
      )
      RETURNING id
    `
    job.client.query(sqlQuery, function (err, res) {
      if (err) return next(err)
      job.organization = res.rows[0]
      next()
    })
  }

  function createDefaultPolicies (job, next) {
    policyOps.createOrgDefaultPolicies(job.client, job.organization.id, function (err, id) {
      if (err) return next(err)
      job.adminPolicyId = id
      next()
    })
  }

  /**
   * Insert a new user and attach to it the organization admin policy
   *
   * NOTE: we are not using userOps.createUser because we need to execute this operation in a transaction with the same client.
   *
   * @param  {Object}   job
   * @param  {Function} next
   */
  function insertOrgAdminUser (job, next) {
    if (job.user) {
      const insertUser = SQL`
        INSERT INTO users (
          id, name, org_id
        )
        VALUES (
          DEFAULT, ${job.user.name}, ${job.organization.id}
        )
        RETURNING id
      `
      job.client.query(insertUser, (err, res) => {
        if (err) return next(err)
        job.user.id = res.rows[0].id

        const insertUserPolicy = SQL`
          INSERT INTO user_policies (
            user_id, policy_id
          )
          VALUES (
            ${job.user.id}, ${job.adminPolicyId}
          )
        `
        job.client.query(insertUserPolicy, next)
      })

      return
    }

    next()
  }

  var organizationOps = {

    /**
     * Fetch all organizations
     *
     * @param  {Function} cb
     */
    list: function list (cb) {
      const sqlQuery = SQL`
        SELECT *
        FROM organizations
        ORDER BY UPPER(name)
      `
      dbPool.query(sqlQuery, function (err, result) {
        if (err) return cb(Boom.badImplementation(err))

        return cb(null, result.rows)
      })
    },

    /**
     * Creates a new organization
     *
     * @param  {Object}   params {id, name, description}
     * @param  {Object}   opts { createOnly }
     * @param  {Function} cb
     */
    create: function create (params, opts, cb) {
      if (!cb) {
        cb = opts
        opts = {}
      }

      const { createOnly } = opts

      const tasks = [
        (job, next) => {
          job.params = params
          job.user = params.user
          next()
        },
        insertOrganization
      ]
      if (!createOnly) {
        tasks.push(
          createDefaultPolicies,
          insertOrgAdminUser
        )
      }

      dbUtil.withTransaction(dbPool, tasks, (err, res) => {
        if (err) return cb(Boom.badImplementation(err))

        organizationOps.readById(res.organization.id, (err, organization) => {
          if (err) return cb(Boom.badImplementation(err))

          cb(null, { organization, user: res.user })
        })
      })
    },

    /**
     * Fetch data for an organization
     *
     * @param  {String}   id
     * @param  {Function} cb
     */
    readById: function readById (id, cb) {
      const sqlQuery = SQL`
        SELECT *
        FROM organizations
        WHERE id = ${id}
      `
      dbPool.query(sqlQuery, function (err, result) {
        if (err) return cb(Boom.badImplementation(err))
        if (result.rowCount === 0) return cb(Boom.notFound())

        return cb(null, result.rows[0])
      })
    },

    /**
     * Delete organization
     *
     * @param  {String}   id
     * @param  {Function} cb
     */
    deleteById: function deleteById (id, cb) {
      const tasks = []
      let usersParams = []
      dbPool.connect(function (err, client, done) {
        if (err) return cb(Boom.badImplementation(err))

        tasks.push((next) => { client.query('BEGIN', next) })
        tasks.push((res, next) => {
          client.query(SQL`SELECT id FROM users WHERE org_id = ${id}`, function (err, result) {
            if (err) return next(err)
            if (result.rowCount === 0) return next(null, [])

            usersParams = result.rows.map(r => r.id)
            next(null, usersParams)
          })
        })
        tasks.push((res, next) => {
          if (usersParams.length === 0) return next(null, res)

          client.query(SQL`DELETE FROM team_members WHERE user_id = ANY (${usersParams})`, next)
        })
        tasks.push((res, next) => {
          if (usersParams.length === 0) return next(null, res)

          client.query(SQL`DELETE FROM user_policies WHERE user_id = ANY (${usersParams})`, next)
        })
        tasks.push((res, next) => {
          client.query(SQL`SELECT id FROM teams WHERE org_id = ${id}`, function (err, result) {
            if (err) return next(err)
            if (result.rowCount === 0) return next(null, [])

            next(null, result.rows.map(r => r.id))
          })
        })
        tasks.push((res, next) => {
          if (res.length === 0) return next(null, res)

          client.query(SQL`DELETE FROM team_policies WHERE team_id  = ANY (${res})`, next)
        })
        tasks.push((res, next) => { client.query(SQL`DELETE FROM policies WHERE org_id = ${id}`, next) })
        tasks.push((res, next) => { client.query(SQL`DELETE FROM teams WHERE org_id = ${id}`, next) })
        tasks.push((res, next) => { client.query(SQL`DELETE FROM users WHERE org_id = ${id}`, next) })
        tasks.push((res, next) => {
          client.query(SQL`DELETE FROM organizations WHERE id = ${id}`, function (err, result) {
            if (err) return next(err)
            if (result.rowCount === 0) return next(Boom.notFound())

            next(null, result)
          })
        })
        tasks.push((res, next) => { client.query('COMMIT', next) })

        async.waterfall(tasks, (err) => {
          if (err) {
            dbUtil.rollback(client, done)
            return cb(err.isBoom ? err : Boom.badImplementation(err))
          }

          done()
          return cb(null)
        })
      })
    },

    /**
     * Updates all (for now) organization properties
     *
     * @param  {Object}   params {id, name, description}
     * @param  {Function} cb
     */
    update: function update (params, cb) {
      let { id, name, description } = params
      const sqlQuery = SQL`
        UPDATE organizations
        SET
          name = ${name},
          description = ${description}
        WHERE id = ${id}
      `
      dbPool.query(sqlQuery, function (err, result) {
        if (err) return cb(Boom.badImplementation(err))
        if (result.rowCount === 0) return cb(Boom.notFound())

        return cb(null, { id, name, description })
      })
    }
  }

  return organizationOps
}
