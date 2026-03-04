/**
 * Tests for batched populate optimization.
 *
 * When the adapter does NOT support native joins (no `.join()` method),
 * Waterline falls back to application-level joining. These tests verify
 * that populates are batched (using a single `{in: [...]}` query) instead
 * of doing one query per parent record (N+1 problem).
 */

var assert = require('assert');
var _ = require('@sailshq/lodash');
var Waterline = require('../../../../lib/waterline');

describe('Batched Populate (no native join) ::', function() {

  // ============================================================
  // belongsTo / model association (single join, to-one)
  // ============================================================
  describe('belongsTo (model) association ::', function() {

    var Contract;
    var findQueries;

    before(function(done) {
      var waterline = new Waterline();

      waterline.registerModel(Waterline.Model.extend({
        identity: 'category',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          name: { type: 'string' }
        }
      }));

      waterline.registerModel(Waterline.Model.extend({
        identity: 'contract',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          title: { type: 'string' },
          category: { model: 'category' }
        }
      }));

      // Adapter WITHOUT join() — forces Path C (application-level joining)
      var adapterDef = {
        identity: 'foo',
        find: function(con, query, cb) {
          findQueries.push(query);

          // Parent query: return contracts
          if (query.using === 'contract') {
            return cb(null, [
              { id: 1, title: 'Contract A', category: 10 },
              { id: 2, title: 'Contract B', category: 10 },  // same category as A
              { id: 3, title: 'Contract C', category: 20 },
              { id: 4, title: 'Contract D', category: 30 },
              { id: 5, title: 'Contract E', category: 10 },  // same category again
            ]);
          }

          // Child query: return categories
          if (query.using === 'category') {
            // Simulate responding to an `in` query
            var requestedIds = [];
            if (query.criteria && query.criteria.where && query.criteria.where.and) {
              _.each(query.criteria.where.and, function(conjunct) {
                if (conjunct.id && conjunct.id.in) {
                  requestedIds = conjunct.id.in;
                }
              });
            }

            var allCategories = [
              { id: 10, name: 'Sales' },
              { id: 20, name: 'Legal' },
              { id: 30, name: 'HR' }
            ];

            var results = _.filter(allCategories, function(cat) {
              return _.contains(requestedIds, cat.id);
            });

            return cb(null, results);
          }

          return cb(null, []);
        }
      };

      var connections = { 'foo': { adapter: 'foobar' } };

      waterline.initialize({ adapters: { foobar: adapterDef }, datastores: connections }, function(err, orm) {
        if (err) { return done(err); }
        Contract = orm.collections.contract;
        return done();
      });
    });

    beforeEach(function() {
      findQueries = [];
    });

    it('should use a single batched query instead of N queries for populate', function(done) {
      Contract.find()
        .populate('category')
        .exec(function(err, contracts) {
          if (err) { return done(err); }

          try {
            // Should have exactly 2 find queries: 1 for parent, 1 for all children (batched)
            assert.equal(findQueries.length, 2, 'Expected exactly 2 queries (1 parent + 1 batched child), but got ' + findQueries.length);

            // First query should be for contracts (parent)
            assert.equal(findQueries[0].using, 'contract');

            // Second query should be for categories (child) with an `in` constraint
            assert.equal(findQueries[1].using, 'category');
            var childWhere = findQueries[1].criteria.where.and;
            var inConstraint = _.find(childWhere, function(c) { return c.id && c.id.in; });
            assert(inConstraint, 'Expected an `in` constraint in the child query');

            // Should have fetched only unique FK values (10, 20, 30), not 5 queries
            var fetchedIds = inConstraint.id.in;
            assert.equal(fetchedIds.length, 3, 'Expected 3 unique category IDs, got ' + fetchedIds.length);
            assert(_.contains(fetchedIds, 10));
            assert(_.contains(fetchedIds, 20));
            assert(_.contains(fetchedIds, 30));
          } catch (e) { return done(e); }

          return done();
        });
    });

    it('should correctly assign populated records back to parents', function(done) {
      Contract.find()
        .populate('category')
        .exec(function(err, contracts) {
          if (err) { return done(err); }

          try {
            assert.equal(contracts.length, 5);

            // Contracts A, B, E all share category 10 (Sales)
            assert.equal(contracts[0].category.name, 'Sales');
            assert.equal(contracts[1].category.name, 'Sales');
            assert.equal(contracts[4].category.name, 'Sales');

            // Contract C has category 20 (Legal)
            assert.equal(contracts[2].category.name, 'Legal');

            // Contract D has category 30 (HR)
            assert.equal(contracts[3].category.name, 'HR');
          } catch (e) { return done(e); }

          return done();
        });
    });
  });

  // ============================================================
  // belongsTo with null/undefined FK values
  // ============================================================
  describe('belongsTo with null/undefined FK values ::', function() {

    var Contract;
    var findQueries;

    before(function(done) {
      var waterline = new Waterline();

      waterline.registerModel(Waterline.Model.extend({
        identity: 'category',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          name: { type: 'string' }
        }
      }));

      waterline.registerModel(Waterline.Model.extend({
        identity: 'contract',
        datastore: 'foo',
        primaryKey: 'id',
        schema: false,
        attributes: {
          id: { type: 'number' },
          title: { type: 'string' },
          category: { model: 'category' }
        }
      }));

      var adapterDef = {
        identity: 'foo',
        find: function(con, query, cb) {
          findQueries.push(query);

          if (query.using === 'contract') {
            return cb(null, [
              { id: 1, title: 'Contract A', category: 10 },
              { id: 2, title: 'Contract B', category: null },
              { id: 3, title: 'Contract C' },  // undefined FK (schemaless)
              { id: 4, title: 'Contract D', category: 10 },
            ]);
          }

          if (query.using === 'category') {
            return cb(null, [
              { id: 10, name: 'Sales' }
            ]);
          }

          return cb(null, []);
        }
      };

      var connections = { 'foo': { adapter: 'foobar' } };

      waterline.initialize({ adapters: { foobar: adapterDef }, datastores: connections }, function(err, orm) {
        if (err) { return done(err); }
        Contract = orm.collections.contract;
        return done();
      });
    });

    beforeEach(function() {
      findQueries = [];
    });

    it('should handle null and undefined FK values gracefully', function(done) {
      Contract.find()
        .populate('category')
        .exec(function(err, contracts) {
          if (err) { return done(err); }

          try {
            assert.equal(contracts.length, 4);

            // Contract A and D have category 10
            assert.equal(contracts[0].category.name, 'Sales');
            assert.equal(contracts[3].category.name, 'Sales');

            // Contract B has null FK — should be null
            assert.strictEqual(contracts[1].category, null);

            // Contract C had undefined FK — should be null
            assert.strictEqual(contracts[2].category, null);

            // Should still be only 2 queries (parent + 1 batched child)
            assert.equal(findQueries.length, 2);
          } catch (e) { return done(e); }

          return done();
        });
    });
  });

  // ============================================================
  // hasMany / collection association (single join, to-many)
  // ============================================================
  describe('hasMany (collection) association ::', function() {

    var User;
    var findQueries;

    before(function(done) {
      var waterline = new Waterline();

      waterline.registerModel(Waterline.Model.extend({
        identity: 'user',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          name: { type: 'string' },
          posts: { collection: 'post', via: 'author' }
        }
      }));

      waterline.registerModel(Waterline.Model.extend({
        identity: 'post',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          title: { type: 'string' },
          author: { model: 'user' }
        }
      }));

      var adapterDef = {
        identity: 'foo',
        find: function(con, query, cb) {
          findQueries.push(query);

          if (query.using === 'user') {
            return cb(null, [
              { id: 1, name: 'Alice' },
              { id: 2, name: 'Bob' },
              { id: 3, name: 'Charlie' },
            ]);
          }

          if (query.using === 'post') {
            var requestedIds = [];
            if (query.criteria && query.criteria.where && query.criteria.where.and) {
              _.each(query.criteria.where.and, function(conjunct) {
                if (conjunct.author && conjunct.author.in) {
                  requestedIds = conjunct.author.in;
                }
              });
            }

            var allPosts = [
              { id: 100, title: 'Post 1', author: 1 },
              { id: 101, title: 'Post 2', author: 1 },
              { id: 102, title: 'Post 3', author: 2 },
              { id: 103, title: 'Post 4', author: 1 },
            ];

            var results = _.filter(allPosts, function(post) {
              return _.contains(requestedIds, post.author);
            });

            return cb(null, results);
          }

          return cb(null, []);
        }
      };

      var connections = { 'foo': { adapter: 'foobar' } };

      waterline.initialize({ adapters: { foobar: adapterDef }, datastores: connections }, function(err, orm) {
        if (err) { return done(err); }
        User = orm.collections.user;
        return done();
      });
    });

    beforeEach(function() {
      findQueries = [];
    });

    it('should use a single batched query for hasMany populate', function(done) {
      User.find()
        .populate('posts')
        .exec(function(err, users) {
          if (err) { return done(err); }

          try {
            // 2 queries: 1 parent + 1 batched child
            assert.equal(findQueries.length, 2, 'Expected 2 queries, got ' + findQueries.length);
            assert.equal(findQueries[1].using, 'post');

            // The child query should use `in` with all unique parent IDs
            var childWhere = findQueries[1].criteria.where.and;
            var inConstraint = _.find(childWhere, function(c) { return c.author && c.author.in; });
            assert(inConstraint, 'Expected an `in` constraint');
            assert.equal(inConstraint.author.in.length, 3);
          } catch (e) { return done(e); }

          return done();
        });
    });

    it('should correctly group child records by parent', function(done) {
      User.find()
        .populate('posts')
        .exec(function(err, users) {
          if (err) { return done(err); }

          try {
            assert.equal(users.length, 3);

            // Alice has 3 posts
            assert.equal(users[0].posts.length, 3);

            // Bob has 1 post
            assert.equal(users[1].posts.length, 1);
            assert.equal(users[1].posts[0].title, 'Post 3');

            // Charlie has 0 posts
            assert.equal(users[2].posts.length, 0);
          } catch (e) { return done(e); }

          return done();
        });
    });
  });

  // ============================================================
  // Empty parent results
  // ============================================================
  describe('with no parent results ::', function() {

    var Contract;
    var findQueries;

    before(function(done) {
      var waterline = new Waterline();

      waterline.registerModel(Waterline.Model.extend({
        identity: 'category',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          name: { type: 'string' }
        }
      }));

      waterline.registerModel(Waterline.Model.extend({
        identity: 'contract',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          category: { model: 'category' }
        }
      }));

      var adapterDef = {
        identity: 'foo',
        find: function(con, query, cb) {
          findQueries.push(query);
          return cb(null, []);
        }
      };

      var connections = { 'foo': { adapter: 'foobar' } };

      waterline.initialize({ adapters: { foobar: adapterDef }, datastores: connections }, function(err, orm) {
        if (err) { return done(err); }
        Contract = orm.collections.contract;
        return done();
      });
    });

    beforeEach(function() {
      findQueries = [];
    });

    it('should not query child table when there are no parent results', function(done) {
      Contract.find()
        .populate('category')
        .exec(function(err, contracts) {
          if (err) { return done(err); }

          try {
            assert.equal(contracts.length, 0);
            // Only 1 query — the parent query. No child query needed.
            assert.equal(findQueries.length, 1);
            assert.equal(findQueries[0].using, 'contract');
          } catch (e) { return done(e); }

          return done();
        });
    });
  });

  // ============================================================
  // Many-to-many batched populate
  // ============================================================
  describe('many-to-many association ::', function() {

    var User;
    var findQueries;

    before(function(done) {
      var waterline = new Waterline();

      waterline.registerModel(Waterline.Model.extend({
        identity: 'user',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          name: { type: 'string' },
          roles: { collection: 'role', via: 'users', dominant: true }
        }
      }));

      waterline.registerModel(Waterline.Model.extend({
        identity: 'role',
        datastore: 'foo',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          name: { type: 'string' },
          users: { collection: 'user', via: 'roles' }
        }
      }));

      var adapterDef = {
        identity: 'foo',
        find: function(con, query, cb) {
          findQueries.push(query);

          // Parent: users
          if (query.using === 'user') {
            return cb(null, [
              { id: 1, name: 'Alice' },
              { id: 2, name: 'Bob' },
              { id: 3, name: 'Charlie' },
            ]);
          }

          // Junction table
          if (query.using === 'role_users__user_roles') {
            return cb(null, [
              { id: 1, user_roles: 1, role_users: 10 },
              { id: 2, user_roles: 1, role_users: 20 },
              { id: 3, user_roles: 2, role_users: 10 },
              { id: 4, user_roles: 3, role_users: 20 },
              { id: 5, user_roles: 3, role_users: 30 },
            ]);
          }

          // Child: roles
          if (query.using === 'role') {
            var requestedIds = [];
            if (query.criteria && query.criteria.where && query.criteria.where.and) {
              _.each(query.criteria.where.and, function(conjunct) {
                if (conjunct.id && conjunct.id.in) {
                  requestedIds = conjunct.id.in;
                }
              });
            }

            var allRoles = [
              { id: 10, name: 'Admin' },
              { id: 20, name: 'Editor' },
              { id: 30, name: 'Viewer' },
            ];

            var results = _.filter(allRoles, function(role) {
              return _.contains(requestedIds, role.id);
            });

            return cb(null, results);
          }

          return cb(null, []);
        }
      };

      var connections = { 'foo': { adapter: 'foobar' } };

      waterline.initialize({ adapters: { foobar: adapterDef }, datastores: connections }, function(err, orm) {
        if (err) { return done(err); }
        User = orm.collections.user;
        return done();
      });
    });

    beforeEach(function() {
      findQueries = [];
    });

    it('should use a single batched query for many-to-many child records', function(done) {
      User.find()
        .populate('roles')
        .exec(function(err, users) {
          if (err) { return done(err); }

          try {
            // 3 queries: 1 parent + 1 junction table + 1 batched child
            assert.equal(findQueries.length, 3, 'Expected 3 queries (parent + junction + 1 batched child), got ' + findQueries.length);
            assert.equal(findQueries[0].using, 'user');
            assert.equal(findQueries[1].using, 'role_users__user_roles');
            assert.equal(findQueries[2].using, 'role');

            // The child query should use `in` with all unique child PKs
            var childWhere = findQueries[2].criteria.where.and;
            var inConstraint = _.find(childWhere, function(c) { return c.id && c.id.in; });
            assert(inConstraint, 'Expected an `in` constraint');
            // Unique role IDs: 10, 20, 30
            assert.equal(inConstraint.id.in.length, 3);
          } catch (e) { return done(e); }

          return done();
        });
    });

    it('should correctly distribute child records to parents via junction table', function(done) {
      User.find()
        .populate('roles')
        .exec(function(err, users) {
          if (err) { return done(err); }

          try {
            assert.equal(users.length, 3);

            // Alice (id=1) has roles 10 (Admin) and 20 (Editor)
            assert.equal(users[0].roles.length, 2);
            var aliceRoleNames = _.pluck(users[0].roles, 'name').sort();
            assert.deepEqual(aliceRoleNames, ['Admin', 'Editor']);

            // Bob (id=2) has role 10 (Admin)
            assert.equal(users[1].roles.length, 1);
            assert.equal(users[1].roles[0].name, 'Admin');

            // Charlie (id=3) has roles 20 (Editor) and 30 (Viewer)
            assert.equal(users[2].roles.length, 2);
            var charlieRoleNames = _.pluck(users[2].roles, 'name').sort();
            assert.deepEqual(charlieRoleNames, ['Editor', 'Viewer']);
          } catch (e) { return done(e); }

          return done();
        });
    });
  });

});
