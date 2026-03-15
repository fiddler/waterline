/**
 * Module dependencies
 */

var util = require('util');
var _ = require('@sailshq/lodash');
var flaverr = require('flaverr');
var rttc = require('rttc');
var getModel = require('../../ontology/get-model');
var getAttribute = require('../../ontology/get-attribute');
var isValidAttributeName = require('./is-valid-attribute-name');
var normalizeComparisonValue = require('./normalize-comparison-value');


/**
 * Module constants
 */


// Deprecated aliases
// (note that some aliases may not be listed here-- for example,
// `not` can actually be an alias for `nin`.)
var MODIFIER_ALIASES = {
  lessThan:             '<',
  lessThanOrEqual:      '<=',
  greaterThan:          '>',
  greaterThanOrEqual:   '>=',
  not:                  '!=',
  '!':                  '!=',
  '!==':                '!='
};


// The official set of supported modifiers.
var MODIFIER_KINDS = {
  '<':          true,
  '<=':         true,
  '>':          true,
  '>=':         true,

  '!=':         true,

  'nin':        true,
  'in':         true,

  'like':       true,
  'contains':   true,
  'startsWith': true,
  'endsWith':   true
};


/**
 * normalizeConstraint()
 *
 * Validate and normalize the provided constraint target (LHS), as well as the RHS.
 *
 * ------------------------------------------------------------------------------------------
 * @param  {Ref} constraintRhs              [may be MUTATED IN PLACE!]
 *
 * @param {String} constraintTarget
 *        The LHS of this constraint; usually, the attribute name it is referring to (unless
 *        the model is `schema: false` or the constraint is invalid).
 *
 * @param {String} modelIdentity
 *        The identity of the model this contraint is referring to (e.g. "pet" or "user")
 *        > Useful for looking up the Waterline model and accessing its attribute definitions.
 *
 * @param {Ref} orm
 *        The Waterline ORM instance.
 *        > Useful for accessing the model definitions.
 *
 * @param {Dictionary?} meta
 *        The contents of the `meta` query key, if one was provided.
 *        > Useful for propagating query options to low-level utilities like this one.
 * ------------------------------------------------------------------------------------------
 * @returns {Dictionary|String|Number|Boolean|JSON}
 *          The constraint (potentially the same ref), guaranteed to be valid for a stage 2 query.
 *          This will always be either a complex constraint (dictionary), or an eq constraint (a
 *          primitive-- string/number/boolean/null)
 * ------------------------------------------------------------------------------------------
 * @throws {Error} if the provided constraint cannot be normalized
 *         @property {String} code (=== "E_CONSTRAINT_NOT_USABLE")
 * ------------------------------------------------------------------------------------------
 * @throws {Error} If the provided constraint would match everything
 *         @property {String} code (=== "E_CONSTRAINT_WOULD_MATCH_EVERYTHING")
 * ------------------------------------------------------------------------------------------
 * @throws {Error} If the provided constraint would NEVER EVER match anything
 *         @property {String} code (=== "E_CONSTRAINT_WOULD_MATCH_NOTHING")
 * ------------------------------------------------------------------------------------------
 * @throws {Error} If anything unexpected happens, e.g. bad usage, or a failed assertion.
 * ------------------------------------------------------------------------------------------
 */

module.exports = function normalizeConstraint (constraintRhs, constraintTarget, modelIdentity, orm, meta){
  if (_.isUndefined(constraintRhs)) {
    throw new Error('Consistency violation: The internal normalizeConstraint() utility must always be called with a first argument (the RHS of the constraint to normalize).  But instead, got: '+util.inspect(constraintRhs, {depth:5})+'');
  }
  if (!_.isString(constraintTarget)) {
    throw new Error('Consistency violation: The internal normalizeConstraint() utility must always be called with a valid second argument (a string).  But instead, got: '+util.inspect(constraintTarget, {depth:5})+'');
  }
  if (!_.isString(modelIdentity)) {
    throw new Error('Consistency violation: The internal normalizeConstraint() utility must always be called with a valid third argument (a string).  But instead, got: '+util.inspect(modelIdentity, {depth:5})+'');
  }


  // Look up the Waterline model for this query.
  var WLModel = getModel(modelIdentity, orm);

  // Before we look at the constraint's RHS, we'll check the key (the constraint target)
  // to be sure it is valid for this model.
  // (in the process, we look up the expected type for the corresponding attribute,
  // so that we have something to validate against)
  var attrName;

  var isDeepTarget;
  var deepTargetHops;
  if (_.isString(constraintTarget)){
    deepTargetHops = constraintTarget.split(/\./);
    isDeepTarget = (deepTargetHops.length > 1);
  }

  if (isDeepTarget) {
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // FUTURE: Replace this opt-in experimental support with official support for
    // deep targets for constraints: i.e. dot notation for lookups within JSON embeds.
    // This will require additional tests + docs, as well as a clear way of indicating
    // whether a particular adapter supports this feature so that proper error messages
    // can be displayed otherwise.
    // (See https://github.com/balderdashy/waterline/pull/1519)
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    if (!meta || !meta.enableExperimentalDeepTargets) {
      throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
        'Cannot use dot notation in a constraint target without enabling experimental support '+
        'for "deep targets".  Please try again with `.meta({enableExperimentalDeepTargets:true})`.'
      ));
    }//•

    attrName = deepTargetHops[0];
  }
  else {
    attrName = constraintTarget;
  }

  // Try to look up the definition of the attribute that this constraint is referring to.
  var attrDef;
  try {
    attrDef = getAttribute(attrName, modelIdentity, orm);
  } catch (e){
    switch (e.code) {
      case 'E_ATTR_NOT_REGISTERED':
        // If no matching attr def exists, then just leave `attrDef` undefined
        // and continue... for now anyway.
        break;
      default: throw e;
    }
  }//</catch>

  // If model is `schema: true`...
  if (WLModel.hasSchema === true) {

    // Make sure this matched a recognized attribute name.
    if (!attrDef) {
      throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
        '`'+attrName+'` is not a recognized attribute for this '+
        'model (`'+modelIdentity+'`).  And since the model declares `schema: true`, '+
        'this is not allowed.'
      ));
    }//-•

  }
  // Else if model is `schema: false`...
  else if (WLModel.hasSchema === false) {

    // Make sure this is at least a valid name for a Waterline attribute.
    if (!isValidAttributeName(attrName)) {
      throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
        '`'+attrName+'` is not a valid name for an attribute in Waterline.  '+
        'Even though this model (`'+modelIdentity+'`) declares `schema: false`, '+
        'this is not allowed.'
      ));
    }//-•

  } else { throw new Error('Consistency violation: Every instantiated Waterline model should always have a `hasSchema` property as either `true` or `false` (should have been derived from the `schema` model setting when Waterline was being initialized).  But somehow, this model (`'+modelIdentity+'`) ended up with `hasSchema: '+util.inspect(WLModel.hasSchema, {depth:5})+'`'); }



  // If this attribute is a plural (`collection`) association, then reject it out of hand.
  // (filtering by plural associations is not supported, regardless of what constraint you're using.)
  if (attrDef && attrDef.collection) {
    throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
      'Cannot filter by `'+attrName+'` because it is a plural association (which wouldn\'t make sense).'
    ));
  }//-•


  if (isDeepTarget) {
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // FUTURE: See the other note above.  This is still experimental.
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    if (isDeepTarget && attrDef && attrDef.type !== 'json' && attrDef.type !== 'ref') {
      throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
        'Cannot use dot notation in a constraint for the `'+attrName+'` attribute.  '+
        (attrDef.model||attrDef.collection?
          'Dot notation is not currently supported for "whose" lookups across associations '+
          '(see https://github.com/balderdashy/waterline/pull/1519 for details).'
          :
          'Dot notation is only supported for fields which might potentially contain embedded JSON.'
        )
      ));
    }//•
  }//ﬁ


  // If this attribute is a singular (`model`) association, then look up
  // the reciprocal model def, as well as its primary attribute def.
  var Reciprocal;
  var reciprocalPKA;
  if (attrDef && attrDef.model) {
    Reciprocal = getModel(attrDef.model, orm);
    reciprocalPKA = getAttribute(Reciprocal.primaryKey, attrDef.model, orm);
  }//>-



  //  ███████╗██╗  ██╗ ██████╗ ██████╗ ████████╗██╗  ██╗ █████╗ ███╗   ██╗██████╗
  //  ██╔════╝██║  ██║██╔═══██╗██╔══██╗╚══██╔══╝██║  ██║██╔══██╗████╗  ██║██╔══██╗
  //  ███████╗███████║██║   ██║██████╔╝   ██║   ███████║███████║██╔██╗ ██║██║  ██║
  //  ╚════██║██╔══██║██║   ██║██╔══██╗   ██║   ██╔══██║██╔══██║██║╚██╗██║██║  ██║
  //  ███████║██║  ██║╚██████╔╝██║  ██║   ██║   ██║  ██║██║  ██║██║ ╚████║██████╔╝
  //  ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝
  //
  //  ███████╗ ██████╗ ██████╗           ██╗███╗   ██╗
  //  ██╔════╝██╔═══██╗██╔══██╗          ██║████╗  ██║
  //  █████╗  ██║   ██║██████╔╝    █████╗██║██╔██╗ ██║█████╗
  //  ██╔══╝  ██║   ██║██╔══██╗    ╚════╝██║██║╚██╗██║╚════╝
  //  ██║     ╚██████╔╝██║  ██║          ██║██║ ╚████║
  //  ╚═╝      ╚═════╝ ╚═╝  ╚═╝          ╚═╝╚═╝  ╚═══╝
  //
  //   ██████╗ ██████╗ ███╗   ██╗███████╗████████╗██████╗  █████╗ ██╗███╗   ██╗████████╗
  //  ██╔════╝██╔═══██╗████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██║████╗  ██║╚══██╔══╝
  //  ██║     ██║   ██║██╔██╗ ██║███████╗   ██║   ██████╔╝███████║██║██╔██╗ ██║   ██║
  //  ██║     ██║   ██║██║╚██╗██║╚════██║   ██║   ██╔══██╗██╔══██║██║██║╚██╗██║   ██║
  //  ╚██████╗╚██████╔╝██║ ╚████║███████║   ██║   ██║  ██║██║  ██║██║██║ ╚████║   ██║
  //   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝
  //
  // If this is "IN" shorthand (an array)...
  if (_.isArray(constraintRhs)) {

    // Normalize this into a complex constraint with an `in` modifier.
    var inConstraintShorthandArray = constraintRhs;
    constraintRhs = { in: inConstraintShorthandArray };

  }//>-

  // If this is a MongoDB ObjectId (or ObjectId-like object), convert it to a string.
  // This handles cases where raw MongoDB results contain BSON ObjectId objects
  // that get passed back into Waterline queries (e.g. from native MongoDB operations).
  if (_.isObject(constraintRhs) && !_.isArray(constraintRhs) && !_.isFunction(constraintRhs)) {
    if (typeof constraintRhs.toHexString === 'function') {
      constraintRhs = constraintRhs.toHexString();
    } else if (constraintRhs._bsontype === 'ObjectId' || constraintRhs._bsontype === 'ObjectID') {
      constraintRhs = constraintRhs.toString();
    }
  }








  //   ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗     ███████╗██╗  ██╗
  //  ██╔════╝██╔═══██╗████╗ ████║██╔══██╗██║     ██╔════╝╚██╗██╔╝
  //  ██║     ██║   ██║██╔████╔██║██████╔╝██║     █████╗   ╚███╔╝
  //  ██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██║     ██╔══╝   ██╔██╗
  //  ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ███████╗███████╗██╔╝ ██╗
  //   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝
  //
  //   ██████╗ ██████╗ ███╗   ██╗███████╗████████╗██████╗  █████╗ ██╗███╗   ██╗████████╗
  //  ██╔════╝██╔═══██╗████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██║████╗  ██║╚══██╔══╝
  //  ██║     ██║   ██║██╔██╗ ██║███████╗   ██║   ██████╔╝███████║██║██╔██╗ ██║   ██║
  //  ██║     ██║   ██║██║╚██╗██║╚════██║   ██║   ██╔══██╗██╔══██║██║██║╚██╗██║   ██║
  //  ╚██████╗╚██████╔╝██║ ╚████║███████║   ██║   ██║  ██║██║  ██║██║██║ ╚████║   ██║
  //   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝
  //
  // If this is a complex constraint (a dictionary)...
  if (_.isObject(constraintRhs) && !_.isFunction(constraintRhs) && !_.isArray(constraintRhs)) {

    //  ┬ ┬┌─┐┌┐┌┌┬┐┬  ┌─┐  ┌─┐┌┬┐┌─┐┌┬┐┬ ┬  ┌┬┐┬┌─┐┌┬┐┬┌─┐┌┐┌┌─┐┬─┐┬ ┬
    //  ├─┤├─┤│││ │││  ├┤   ├┤ │││├─┘ │ └┬┘   ││││   │ ││ ││││├─┤├┬┘└┬┘
    //  ┴ ┴┴ ┴┘└┘─┴┘┴─┘└─┘  └─┘┴ ┴┴   ┴  ┴   ─┴┘┴└─┘ ┴ ┴└─┘┘└┘┴ ┴┴└─ ┴
    // An empty dictionary (or a dictionary w/ an unrecognized modifier key)
    // is never allowed as a complex constraint.
    var numKeys = _.keys(constraintRhs).length;
    if (numKeys === 0) {
      throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
        'If specifying a complex constraint, there should always be at least one modifier.  But the constraint provided as `'+constraintTarget+'` has no keys-- it is just `{}`, an empty dictionary (aka plain JavaScript object).'
      ));
    }//-•

    if (numKeys !== 1) {
      throw new Error('Consistency violation: If provided as a dictionary, the constraint RHS passed in to the internal normalizeConstraint() utility must always have exactly one key.  (Should have been normalized already.)  But instead, got: '+util.inspect(constraintRhs, {depth:5})+'');
    }

    // Determine what kind of modifier this constraint has, and get a reference to the modifier's RHS.
    // > Note that we HAVE to set `constraint[modifierKind]` any time we make a by-value change.
    // > We take care of this at the bottom of this section.
    var modifierKind = _.keys(constraintRhs)[0];
    var modifier = constraintRhs[modifierKind];




    //  ┬ ┬┌─┐┌┐┌┌┬┐┬  ┌─┐  ┌─┐┬  ┬┌─┐┌─┐┌─┐┌─┐
    //  ├─┤├─┤│││ │││  ├┤   ├─┤│  │├─┤└─┐├┤ └─┐
    //  ┴ ┴┴ ┴┘└┘─┴┘┴─┘└─┘  ┴ ┴┴─┘┴┴ ┴└─┘└─┘└─┘
    // Handle simple modifier aliases, for compatibility.
    if (!MODIFIER_KINDS[modifierKind] && MODIFIER_ALIASES[modifierKind]) {
      var originalModifierKind = modifierKind;
      delete constraintRhs[originalModifierKind];
      modifierKind = MODIFIER_ALIASES[originalModifierKind];
      constraintRhs[modifierKind] = modifier;

      console.warn();
      console.warn(
        'Deprecated: The `where` clause of this query contains '+'\n'+
        'a `'+originalModifierKind+'` modifier (for `'+constraintTarget+'`).  But as of Sails v1.0,'+'\n'+
        'this modifier is deprecated.  (Please use `'+modifierKind+'` instead.)\n'+
        'This was automatically normalized on your behalf for the'+'\n'+
        'sake of compatibility, but please change this ASAP.'+'\n'+
        '> Warning: This backwards compatibility may be removed\n'+
        '> in a future release of Sails/Waterline.  If this usage\n'+
        '> is left unchanged, then queries like this one may eventually \n'+
        '> fail with an error.'
      );
      console.warn();

    }//>-

    // Understand the "!=" modifier as "nin" if it was provided as an array.
    if (modifierKind === '!=' && _.isArray(modifier)) {
      delete constraintRhs[modifierKind];
      modifierKind = 'nin';
      constraintRhs[modifierKind] = modifier;
    }//>-



    //
    // --• At this point, we're doing doing uninformed transformations of the constraint.
    // i.e. while, in some cases, the code below changes the `modifierKind`, the
    // following if/else statements are effectively a switch statement.  So in other
    // words, any transformations going on are specific to a particular `modifierKind`.
    //



    //  ╔╗╔╔═╗╔╦╗  ╔═╗╔═╗ ╦ ╦╔═╗╦
    //  ║║║║ ║ ║   ║╣ ║═╬╗║ ║╠═╣║
    //  ╝╚╝╚═╝ ╩   ╚═╝╚═╝╚╚═╝╩ ╩╩═╝
    if (modifierKind === '!=') {

      // Ensure this modifier is valid, normalizing it if possible.
      try {
        modifier = normalizeComparisonValue(modifier, constraintTarget, modelIdentity, orm);
      } catch (e) {
        switch (e.code) {
          case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid `!=` ("not equal") modifier.  '+e.message));
          default:                   throw e;
        }
      }//>-•

    }//‡
    //  ╦╔╗╔
    //  ║║║║
    //  ╩╝╚╝
    else if (modifierKind === 'in') {

      if (!_.isArray(modifier)) {
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'An `in` modifier should always be provided as an array.  '+
          'But instead, for the `in` modifier at `'+constraintTarget+'`, got: '+
          util.inspect(modifier, {depth:5})+''
        ));
      }//-•

      // Strip undefined items.
      _.remove(modifier, function (item) { return item === undefined; });

      // If this modifier is now an empty array, then bail with a special exception.
      if (modifier.length === 0) {
        throw flaverr('E_CONSTRAINT_WOULD_MATCH_NOTHING', new Error(
          'Since this `in` modifier is an empty array, it would match nothing.'
        ));
      }//-•

      // Ensure that each item in the array matches the expected data type for the attribute.
      modifier = _.map(modifier, function (item){

        // First, ensure this is not `null`.
        // (We never allow items in the array to be `null`.)
        if (_.isNull(item)){
          throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
            'Got unsupported value (`null`) in an `in` modifier array.  Please use `or: [{ '+constraintTarget+': null }, ...]` instead.'
          ));
        }//-•

        // Ensure this item is valid, normalizing it if possible.
        try {
          item = normalizeComparisonValue(item, constraintTarget, modelIdentity, orm);
        } catch (e) {
          switch (e.code) {
            case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid item within `in` modifier array.  '+e.message));
            default:                   throw e;
          }
        }//>-•

        return item;

      });//</_.map>

    }//‡
    //  ╔╗╔╦╔╗╔
    //  ║║║║║║║
    //  ╝╚╝╩╝╚╝
    else if (modifierKind === 'nin') {

      if (!_.isArray(modifier)) {
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `nin` ("not in") modifier should always be provided as an array.  '+
          'But instead, for the `nin` modifier at `'+constraintTarget+'`, got: '+
          util.inspect(modifier, {depth:5})+''
        ));
      }//-•

      // Strip undefined items.
      _.remove(modifier, function (item) { return item === undefined; });

      // If this modifier is now an empty array, then bail with a special exception.
      if (modifier.length === 0) {
        throw flaverr('E_CONSTRAINT_WOULD_MATCH_EVERYTHING', new Error(
          'Since this `nin` ("not in") modifier is an empty array, it would match ANYTHING.'
        ));
      }//-•

      // Ensure that each item in the array matches the expected data type for the attribute.
      modifier = _.map(modifier, function (item){

        // First, ensure this is not `null`.
        // (We never allow items in the array to be `null`.)
        if (_.isNull(item)){
          throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
            'Got unsupported value (`null`) in a `nin` ("not in") modifier array.  Please use `or: [{ '+constraintTarget+': { \'!=\': null }, ...]` instead.'
          ));
        }//-•

        // Ensure this item is valid, normalizing it if possible.
        try {
          item = normalizeComparisonValue(item, constraintTarget, modelIdentity, orm);
        } catch (e) {
          switch (e.code) {
            case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid item within `nin` ("not in") modifier array.  '+e.message));
            default:                   throw e;
          }
        }//>-•

        return item;

      });//</_.map>

    }//‡
    //  ╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗╦═╗  ╔╦╗╦ ╦╔═╗╔╗╔
    //  ║ ╦╠╦╝║╣ ╠═╣ ║ ║╣ ╠╦╝   ║ ╠═╣╠═╣║║║
    //  ╚═╝╩╚═╚═╝╩ ╩ ╩ ╚═╝╩╚═   ╩ ╩ ╩╩ ╩╝╚╝
    // `>` ("greater than")
    else if (modifierKind === '>') {

      // If it matches a known attribute, verify that the attribute does not declare
      // itself `type: 'boolean'` (it wouldn't make any sense to attempt that)
      if (attrDef && attrDef.type === 'boolean'){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `>` ("greater than") modifier cannot be used with a boolean attribute.  (Please use `or` instead.)'
        ));
      }//-•

      // Ensure this modifier is valid, normalizing it if possible.
      // > Note that, in addition to using the standard utility, we also verify that this
      // > was not provided as `null`.  (It wouldn't make any sense.)
      try {

        if (_.isNull(modifier)){
          throw flaverr('E_VALUE_NOT_USABLE', new Error(
            '`null` is not supported with comparison modifiers.  '+
            'Please use `or: [{ '+constraintTarget+': { \'!=\': null }, ...]` instead.'
          ));
        }//-•

        modifier = normalizeComparisonValue(modifier, constraintTarget, modelIdentity, orm);

      } catch (e) {
        switch (e.code) {
          case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid `>` ("greater than") modifier.  '+e.message));
          default:                   throw e;
        }
      }//>-•

    }//‡
    //  ╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗╦═╗  ╔╦╗╦ ╦╔═╗╔╗╔  ╔═╗╦═╗  ╔═╗╔═╗ ╦ ╦╔═╗╦
    //  ║ ╦╠╦╝║╣ ╠═╣ ║ ║╣ ╠╦╝   ║ ╠═╣╠═╣║║║  ║ ║╠╦╝  ║╣ ║═╬╗║ ║╠═╣║
    //  ╚═╝╩╚═╚═╝╩ ╩ ╩ ╚═╝╩╚═   ╩ ╩ ╩╩ ╩╝╚╝  ╚═╝╩╚═  ╚═╝╚═╝╚╚═╝╩ ╩╩═╝
    // `>=` ("greater than or equal")
    else if (modifierKind === '>=') {

      // If it matches a known attribute, verify that the attribute does not declare
      // itself `type: 'boolean'` (it wouldn't make any sense to attempt that)
      if (attrDef && attrDef.type === 'boolean'){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `>=` ("greater than or equal") modifier cannot be used with a boolean attribute.  (Please use `or` instead.)'
        ));
      }//-•

      // Ensure this modifier is valid, normalizing it if possible.
      // > Note that, in addition to using the standard utility, we also verify that this
      // > was not provided as `null`.  (It wouldn't make any sense.)
      try {

        if (_.isNull(modifier)){
          throw flaverr('E_VALUE_NOT_USABLE', new Error(
            '`null` is not supported with comparison modifiers.  '+
            'Please use `or: [{ '+constraintTarget+': { \'!=\': null }, ...]` instead.'
          ));
        }//-•

        modifier = normalizeComparisonValue(modifier, constraintTarget, modelIdentity, orm);

      } catch (e) {
        switch (e.code) {
          case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid `>=` ("greater than or equal") modifier.  '+e.message));
          default:                   throw e;
        }
      }//>-•

    }//‡
    //  ╦  ╔═╗╔═╗╔═╗  ╔╦╗╦ ╦╔═╗╔╗╔
    //  ║  ║╣ ╚═╗╚═╗   ║ ╠═╣╠═╣║║║
    //  ╩═╝╚═╝╚═╝╚═╝   ╩ ╩ ╩╩ ╩╝╚╝
    // `<` ("less than")
    else if (modifierKind === '<') {

      // If it matches a known attribute, verify that the attribute does not declare
      // itself `type: 'boolean'` (it wouldn't make any sense to attempt that)
      if (attrDef && attrDef.type === 'boolean'){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `<` ("less than") modifier cannot be used with a boolean attribute.  (Please use `or` instead.)'
        ));
      }//-•

      // Ensure this modifier is valid, normalizing it if possible.
      // > Note that, in addition to using the standard utility, we also verify that this
      // > was not provided as `null`.  (It wouldn't make any sense.)
      try {

        if (_.isNull(modifier)){
          throw flaverr('E_VALUE_NOT_USABLE', new Error(
            '`null` is not supported with comparison modifiers.  '+
            'Please use `or: [{ '+constraintTarget+': { \'!=\': null }, ...]` instead.'
          ));
        }//-•

        modifier = normalizeComparisonValue(modifier, constraintTarget, modelIdentity, orm);

      } catch (e) {
        switch (e.code) {
          case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid `<` ("less than") modifier.  '+e.message));
          default:                   throw e;
        }
      }//>-•

    }//‡
    //  ╦  ╔═╗╔═╗╔═╗  ╔╦╗╦ ╦╔═╗╔╗╔  ╔═╗╦═╗  ╔═╗╔═╗ ╦ ╦╔═╗╦
    //  ║  ║╣ ╚═╗╚═╗   ║ ╠═╣╠═╣║║║  ║ ║╠╦╝  ║╣ ║═╬╗║ ║╠═╣║
    //  ╩═╝╚═╝╚═╝╚═╝   ╩ ╩ ╩╩ ╩╝╚╝  ╚═╝╩╚═  ╚═╝╚═╝╚╚═╝╩ ╩╩═╝
    // `<=` ("less than or equal")
    else if (modifierKind === '<=') {

      // If it matches a known attribute, verify that the attribute does not declare
      // itself `type: 'boolean'` (it wouldn't make any sense to attempt that)
      if (attrDef && attrDef.type === 'boolean'){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `<=` ("less than or equal") modifier cannot be used with a boolean attribute.  (Please use `or` instead.)'
        ));
      }//-•

      // Ensure this modifier is valid, normalizing it if possible.
      // > Note that, in addition to using the standard utility, we also verify that this
      // > was not provided as `null`.  (It wouldn't make any sense.)
      try {

        if (_.isNull(modifier)){
          throw flaverr('E_VALUE_NOT_USABLE', new Error(
            '`null` is not supported with comparison modifiers.  '+
            'Please use `or: [{ '+constraintTarget+': { \'!=\': null }, ...]` instead.'
          ));
        }//-•

        modifier = normalizeComparisonValue(modifier, constraintTarget, modelIdentity, orm);

      } catch (e) {
        switch (e.code) {
          case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error('Invalid `<=` ("less than or equal") modifier.  '+e.message));
          default:                   throw e;
        }
      }//>-•

    }//‡
    //  ╔═╗╔═╗╔╗╔╔╦╗╔═╗╦╔╗╔╔═╗
    //  ║  ║ ║║║║ ║ ╠═╣║║║║╚═╗
    //  ╚═╝╚═╝╝╚╝ ╩ ╩ ╩╩╝╚╝╚═╝
    else if (modifierKind === 'contains') {

      // If it matches a known attribute, verify that the attribute
      // does not declare itself `type: 'boolean'` or `type: 'number'`;
      // and also, if it is a singular association, that the associated
      // model's primary key value is not a number either.
      if (attrDef && (
        attrDef.type === 'number' ||
        attrDef.type === 'boolean' ||
        (attrDef.model && reciprocalPKA.type === 'number')
      )){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `contains` (i.e. string search) modifier cannot be used with a '+
          'boolean or numeric attribute (it wouldn\'t make any sense).'
        ));
      }//>-•

      // Ensure that this modifier is a string, normalizing it if possible.
      // (note that this explicitly forbids the use of `null`)
      try {
        modifier = rttc.validate('string', modifier);
      } catch (e) {
        switch (e.code) {

          case 'E_INVALID':
            throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
              'Invalid `contains` (string search) modifier.  '+e.message
            ));

          default:
            throw e;
        }
      }//</catch>


      // If this modifier is the empty string (''), then it means that
      // this constraint would match EVERYTHING.
      if (modifier === '') {
        throw flaverr('E_CONSTRAINT_WOULD_MATCH_EVERYTHING', new Error(
          'Since this `contains` (string search) modifier was provided as '+
          '`\'\'` (empty string), it would match ANYTHING!'
        ));
      }//-•

      // Convert this modifier into a `like`, making the necessary adjustments.
      //
      // > This involves escaping any existing occurences of '%',
      // > converting them to '\\%' instead.
      // > (It's actually just one backslash, but...you know...strings )
      delete constraintRhs[modifierKind];
      modifierKind = 'like';
      modifier = modifier.replace(/%/g,'\\%');
      modifier = '%'+modifier+'%';
      constraintRhs[modifierKind] = modifier;

    }//‡
    //  ╔═╗╔╦╗╔═╗╦═╗╔╦╗╔═╗  ╦ ╦╦╔╦╗╦ ╦
    //  ╚═╗ ║ ╠═╣╠╦╝ ║ ╚═╗  ║║║║ ║ ╠═╣
    //  ╚═╝ ╩ ╩ ╩╩╚═ ╩ ╚═╝  ╚╩╝╩ ╩ ╩ ╩
    else if (modifierKind === 'startsWith') {

      // If it matches a known attribute, verify that the attribute
      // does not declare itself `type: 'boolean'` or `type: 'number'`;
      // and also, if it is a singular association, that the associated
      // model's primary key value is not a number either.
      if (attrDef && (
        attrDef.type === 'number' ||
        attrDef.type === 'boolean' ||
        (attrDef.model && reciprocalPKA.type === 'number')
      )){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `startsWith` (i.e. string search) modifier cannot be used with a '+
          'boolean or numeric attribute (it wouldn\'t make any sense).'
        ));
      }//>-•

      // Ensure that this modifier is a string, normalizing it if possible.
      // (note that this explicitly forbids the use of `null`)
      try {
        modifier = rttc.validate('string', modifier);
      } catch (e) {
        switch (e.code) {

          case 'E_INVALID':
            throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
              'Invalid `startsWith` (string search) modifier.  '+e.message
            ));

          default:
            throw e;
        }
      }//</catch>

      // If this modifier is the empty string (''), then it means that
      // this constraint would match EVERYTHING.
      if (modifier === '') {
        throw flaverr('E_CONSTRAINT_WOULD_MATCH_EVERYTHING', new Error(
          'Since this `startsWith` (string search) modifier was provided as '+
          '`\'\'` (empty string), it would match ANYTHING!'
        ));
      }//-•

      // Convert this modifier into a `like`, making the necessary adjustments.
      //
      // > This involves escaping any existing occurences of '%',
      // > converting them to '\\%' instead.
      // > (It's actually just one backslash, but...you know...strings )
      delete constraintRhs[modifierKind];
      modifierKind = 'like';
      modifier = modifier.replace(/%/g,'\\%');
      modifier = modifier+'%';
      constraintRhs[modifierKind] = modifier;

    }//‡
    //  ╔═╗╔╗╔╔╦╗╔═╗  ╦ ╦╦╔╦╗╦ ╦
    //  ║╣ ║║║ ║║╚═╗  ║║║║ ║ ╠═╣
    //  ╚═╝╝╚╝═╩╝╚═╝  ╚╩╝╩ ╩ ╩ ╩
    else if (modifierKind === 'endsWith') {

      // If it matches a known attribute, verify that the attribute
      // does not declare itself `type: 'boolean'` or `type: 'number'`;
      // and also, if it is a singular association, that the associated
      // model's primary key value is not a number either.
      if (attrDef && (
        attrDef.type === 'number' ||
        attrDef.type === 'boolean' ||
        (attrDef.model && reciprocalPKA.type === 'number')
      )){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'An `endsWith` (i.e. string search) modifier cannot be used with a '+
          'boolean or numeric attribute (it wouldn\'t make any sense).'
        ));
      }//>-•

      // Ensure that this modifier is a string, normalizing it if possible.
      // (note that this explicitly forbids the use of `null`)
      try {
        modifier = rttc.validate('string', modifier);
      } catch (e) {
        switch (e.code) {

          case 'E_INVALID':
            throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
              'Invalid `endsWith` (string search) modifier.  '+e.message
            ));

          default:
            throw e;
        }
      }//</catch>

      // If this modifier is the empty string (''), then it means that
      // this constraint would match EVERYTHING.
      if (modifier === '') {
        throw flaverr('E_CONSTRAINT_WOULD_MATCH_EVERYTHING', new Error(
          'Since this `endsWith` (string search) modifier was provided as '+
          '`\'\'` (empty string), it would match ANYTHING!'
        ));
      }//-•

      // Convert this modifier into a `like`, making the necessary adjustments.
      //
      // > This involves escaping any existing occurences of '%',
      // > converting them to '\\%' instead.
      // > (It's actually just one backslash, but...you know...strings )
      delete constraintRhs[modifierKind];
      modifierKind = 'like';
      modifier = modifier.replace(/%/g,'\\%');
      modifier = '%'+modifier;
      constraintRhs[modifierKind] = modifier;

    }//‡
    //  ╦  ╦╦╔═╔═╗
    //  ║  ║╠╩╗║╣
    //  ╩═╝╩╩ ╩╚═╝
    else if (modifierKind === 'like') {

      // If it matches a known attribute, verify that the attribute
      // does not declare itself `type: 'boolean'` or `type: 'number'`;
      // and also, if it is a singular association, that the associated
      // model's primary key value is not a number either.
      if (attrDef && (
        attrDef.type === 'number' ||
        attrDef.type === 'boolean' ||
        (attrDef.model && reciprocalPKA.type === 'number')
      )){
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'A `like` (i.e. SQL-style "LIKE") modifier cannot be used with a '+
          'boolean or numeric attribute (it wouldn\'t make any sense).'
        ));
      }//>-•

      // Strictly verify that this modifier is a string.
      // > You should really NEVER use anything other than a non-empty string for
      // > `like`, because of the special % syntax.  So we won't try to normalize
      // > for you.
      if (!_.isString(modifier) || modifier === '') {
        throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
          'Invalid `like` (i.e. SQL-style "LIKE") modifier.  Should be provided as '+
          'a non-empty string, using `%` symbols as wildcards, but instead, got: '+
          util.inspect(modifier,{depth: 5})+''
        ));
      }//-•

      // If this modifier is '%%', then it means that this `like` constraint
      // would match EVERYTHING.
      if (modifier === '%%') {
        throw flaverr('E_CONSTRAINT_WOULD_MATCH_EVERYTHING', new Error(
          'Since this `like` (string search) modifier was provided as '+
          '`%%`, it would match ANYTHING!'
        ));
      }//-•

    }//‡
    //  ┬ ┬┌┐┌┬─┐┌─┐┌─┐┌─┐┌─┐┌┐┌┬┌─┐┌─┐┌┬┐  ┌┬┐┌─┐┌┬┐┬┌─┐┬┌─┐┬─┐
    //  │ ││││├┬┘├┤ │  │ ││ ┬││││┌─┘├┤  ││  ││││ │ │││├┤ │├┤ ├┬┘
    //  └─┘┘└┘┴└─└─┘└─┘└─┘└─┘┘└┘┴└─┘└─┘─┴┘  ┴ ┴└─┘─┴┘┴└  ┴└─┘┴└─
    // A complex constraint must always contain a recognized modifier.
    else {

      throw flaverr('E_CONSTRAINT_NOT_USABLE', new Error(
        'Unrecognized modifier (`'+modifierKind+'`) within provided constraint for `'+constraintTarget+'`.'
      ));

    }//>-•


    // Just in case we made a by-value change above, set our potentially-modified modifier
    // on the constraint.
    constraintRhs[modifierKind] = modifier;

  }
  //  ███████╗ ██████╗      ██████╗ ██████╗ ███╗   ██╗███████╗████████╗██████╗  █████╗ ██╗███╗   ██╗████████╗
  //  ██╔════╝██╔═══██╗    ██╔════╝██╔═══██╗████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██║████╗  ██║╚══██╔══╝
  //  █████╗  ██║   ██║    ██║     ██║   ██║██╔██╗ ██║███████╗   ██║   ██████╔╝███████║██║██╔██╗ ██║   ██║
  //  ██╔══╝  ██║▄▄ ██║    ██║     ██║   ██║██║╚██╗██║╚════██║   ██║   ██╔══██╗██╔══██║██║██║╚██╗██║   ██║
  //  ███████╗╚██████╔╝    ╚██████╗╚██████╔╝██║ ╚████║███████║   ██║   ██║  ██║██║  ██║██║██║ ╚████║   ██║
  //  ╚══════╝ ╚══▀▀═╝      ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝
  //
  // Otherwise, ensure that this constraint is a valid eq constraint, including schema-aware
  // normalization vs. the attribute def.
  //
  // > If there is no attr def, then check that it's a string, number, boolean, or `null`.
  else {

    // Ensure the provided eq constraint is valid, normalizing it if possible.
    try {
      constraintRhs = normalizeComparisonValue(constraintRhs, constraintTarget, modelIdentity, orm);
    } catch (e) {
      switch (e.code) {
        case 'E_VALUE_NOT_USABLE': throw flaverr('E_CONSTRAINT_NOT_USABLE', e);
        default:                   throw e;
      }
    }//>-•

  }//>-  </ else >

  // Return the normalized constraint.
  return constraintRhs;

};

