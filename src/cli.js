const fs = require('fs')
const glob = require('glob')
const chalk = require('chalk')
const yaml = require('js-yaml')
const assert = require('assert')
const lodash = require('lodash')
const nodepath = require('path')
const emojify = require('node-emoji').emojify


// Helpers

async function parseSpecs(path) {

  // Specs
  const specmap = {}
  let filepaths = glob.sync(`${path}/**/*.yml`)
  for (const filepath of filepaths) {
    const filecont = fs.readFileSync(filepath, 'utf8')
    const spec = await parseSpec(filecont)
    if (!spec) continue
    if (!specmap[spec.package]) {
      specmap[spec.package] = spec
    } else {
      specmap[spec.package].features = specmap[spec.package].features.concat(spec.features)
      specmap[spec.package].scope = Object.assign({}, specmap[spec.package].scope, spec.scope)
    }
  }

  // Hooks
  let hookmap = {}
  filepaths = glob.sync(`${path}/**/packspec.js`)
  for (const filepath of filepaths) {
    const relpath = nodepath.relative(__dirname, filepath)
    const module = require(relpath)
    for (const [name, value] of Object.entries(module)) {
      hookmap[`$${name}`] = value
    }
  }

  // Result
  const specs = Object.keys(specmap).sort().map(key => specmap[key])
  for (const spec of specs) {
    let skip = false
    spec.ready = !lodash.isEmpty(spec.scope)
    spec.stats = {features: 0, comments: 0, skipped: 0, tests: 0}
    spec.features.forEach((feature, index) => {
      if (feature.assign === 'PACKAGE' && index) {
        delete spec.features[index]
      }
      spec.stats.features += 1
      if (feature.comment) {
        skip = feature.skip
        spec.stats.comments += 1
      }
      feature.skip = skip || feature.skip
      if (!feature.comment) {
        spec.stats.tests += 1
        if (feature.skip) {
          spec.stats.skipped += 1
        }
      }
    })
    spec.scope = Object.assign({}, spec.scope, hookmap)
  }

  return specs
}


async function parseSpec(spec) {

  // Package
  let packageName
  const contents = yaml.safeLoad(spec)
  try {
    const feature = await parseFeature(contents[0])
    packageName = feature.result
    if (lodash.isString(packageName)) {
      packageName = {default: [packageName]}
    } else if (lodash.isArray(packageName)) {
      packageName = {default: packageName}
    } else if (lodash.isPlainObject(packageName)) {
      for (const [key, value] of Object.entries(packageName)) {
        packageName[key] = (lodash.isArray(value)) ? value : [value]
      }
    }
    assert(feature.assign === 'PACKAGE')
    assert(!feature.skip)
  } catch (error) {
    return null
  }

  // Features
  const features = []
  for (const item of contents) {
    const feature = await parseFeature(item)
    features.push(feature)
  }

  // Scope
  let scope = {}
  let packages = []
  let attributes = {}
  for (const [namespace, moduleNames] of Object.entries(packageName)) {
    packages = packages.concat(moduleNames)
    let namespaceScope = scope
    if (namespace !== 'default') {
      if (!scope[namespace]) scope[namespace] = {}
      namespaceScope = scope[namespace]
    }
    for (const moduleName of moduleNames) {
      try {
        attributes = require(moduleName)
      } catch (exception) {
        attributes = {}
      }
      lodash.assign(namespaceScope, attributes)
      if (!lodash.isEmpty(attributes)) {
        break
      }
    }
    if (lodash.isEmpty(attributes)) {
      scope = {}
      break
    }
  }
  packageName = packages.sort().join('/')

  return {package: packageName, features, scope}
}


async function parseFeature(feature) {
  if (lodash.isString(feature)) {
    return {comment: feature}
  }
  let [left, right] = Object.entries(feature)[0]

  // Left side
  let call = false
  left = left.replace(/(_.)/g, match => match[1].toUpperCase())
  const match = /^(?:(.*):)?(?:([^=]*)=)?([^=].*)?$/g.exec(left)
  let [skip, assign, property] = match.slice(1)
  if (skip) {
    const filters = skip.split(':')
    skip = (filters[0] === 'not') === (filters.includes('js'))
  }
  if (!assign && !property) {
    throw new Error('Non-valid feature')
  }
  if (property) {
    call = true
    if (property.endsWith('==')) {
      property = property.slice(0, -2)
      call = false
    }
  }

  // Right side
  let args = []
  let kwargs = {}
  let result = right
  if (call) {
    result = null
    for (const item of right) {
      if (lodash.isPlainObject(item) && lodash.size(item) === 1) {
        let [itemLeft, itemRight] = Object.entries(item)[0]
        if (itemLeft === '==') {
          result = itemRight
          continue
        }
        if (itemLeft.endsWith('=')) {
          kwargs[itemLeft.slice(0, -1)] = itemRight
          continue
        }
      }
      args.push(item)
    }
  }

  // Text repr
  let text = property
  if (assign) {
    text = `${assign} = ${property || JSON.stringify(result)}`
  }
  if (call) {
    const items = []
    for (const item of args) {
      items.push(JSON.stringify(item))
    }
    for (const [name, item] of Object.entries(kwargs)) {
      items.push(`${name}=${JSON.stringify(item)}`)
    }
    text = `${text}(${items.join(', ')})`
  }
  if (result && !assign) {
    text = `${text} == ${(result !== 'ERROR') ? JSON.stringify(result) : result}`
  }
  text = text.replace(/{"([^{}]*?)":null}/g, '$1')

  return {comment: null, skip, call, assign, property, args, kwargs, result, text}
}


async function testSpecs(specs) {
  let success = true
  let message = emojify('\n #  ')
  message += chalk.bold('JavaScript\n')
  console.log(message)
  for (const spec of specs) {
    const specSuccess = await testSpec(spec)
    success = success && specSuccess
  }
  return success
}


async function testSpec(spec) {
  let passed = 0
  const amount = spec.features.length
  console.log(emojify(':heavy_minus_sign::heavy_minus_sign::heavy_minus_sign:\n'))
  for (const feature of spec.features) {
    passed += await testFeature(feature, spec.scope, spec.ready)
  }
  const success = (passed === amount)
  let color = 'green'
  let message = chalk.green.bold(emojify('\n :heavy_check_mark:  '))
  if (!success) {
    color = 'red'
    message = chalk.red.bold(emojify('\n :x:  '))
  }
  message += chalk[color].bold(`${spec.package}: ${passed}/${amount}\n`)
  console.log(message)
  return success
}


async function testFeature(feature, scope, ready) {

  // Comment
  if (feature.comment) {
    let message = emojify('\n #  ')
    message += chalk.bold(`${feature.comment}\n`)
    console.log(message)
    return true
  }

  // Skip
  if (feature.skip) {
    let message = chalk.yellow(emojify(' :heavy_minus_sign:  '))
    message += `${feature.text}`
    console.log(message)
    return true
  }

  // Dereference
  feature = lodash.cloneDeep(feature)
  if (feature.call) {
    feature.args = dereferenceValue(feature.args, scope)
    feature.kwargs = dereferenceValue(feature.kwargs, scope)
  }
  feature.result = dereferenceValue(feature.result, scope)

  // Execute
  let exception = null
  let result = feature.result
  if (feature.property) {
    try {
      let owner = scope
      const names = feature.property.split('.')
      const lastName = names[names.length - 1]
      for (const name of names.slice(0, -1)) {
        owner = owner[name]
      }
      const property = owner[lastName]
      if (feature.call) {
        const firstLetter = lastName[0]
        const args = [...feature.args]
        if (lodash.size(feature.kwargs)) {
          args.push(feature.kwargs)
        }
        if (firstLetter === firstLetter.toUpperCase()) {
          result = await new property(...args)
        } else {
          result = await property.bind(owner)(...args)
        }
      } else {
        result = property
      }
    } catch (exc) {
      exception = exc
      result = 'ERROR'
    }
  }

  // Assign
  if (feature.assign) {
    if (feature.assign === 'PACKAGE' && !ready) {
      result = 'ERROR'
      exception = new Error('Package can\'t be fully imported')
    } else {
      let owner = scope
      const names = feature.assign.split('.')
      const lastName = names[names.length - 1]
      for (const name of names.slice(0, -1)) {
        owner = owner[name]
      }
      if (owner[lastName] !== undefined && lastName === lastName.toUpperCase()) {
        throw new Error(`Can't update the constant ${lastName}`)
      }
      owner[lastName] = result
    }
  }

  // Compare
  const success = (feature.result !== null) ? lodash.isEqual(result, feature.result) : result !== 'ERROR'
  if (success) {
    let message = chalk.green(emojify(' :heavy_check_mark:  '))
    message += `${feature.text}`
    console.log(message)
  } else {
    let message = chalk.red(emojify(' :x:  '))
    message += `${feature.text}\n`
    if (exception) {
      message += chalk.red.bold(`Exception: ${exception}`)
    } else {
      message += chalk.red.bold(`Assertion: ${JSON.stringify(result)} != ${JSON.stringify(feature.result)}`)
    }
    console.log(message)
  }

  return success
}


function dereferenceValue(value, scope) {
  value = lodash.cloneDeep(value)
  if (lodash.isPlainObject(value) && lodash.size(value) === 1 && Object.values(value)[0] === null) {
    let result = scope
    for (const name of Object.keys(value)[0].split('.')) {
      result = result[name]
    }
    value = result
  } else if (lodash.isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      value[key] = dereferenceValue(value[key], scope)
    }
  } else if (lodash.isArray(value)) {
    for (const index in value) {
      value[index] = dereferenceValue(value[index], scope)
    }
  }
  return value
}


// Main program

let argv = [...process.argv]
if (argv[0].endsWith('node')) {
  argv = argv.slice(1)
}
const path = argv[1] || '.'
parseSpecs(path).then(specs => {
  testSpecs(specs).then(success => {
    if (!success) process.exit(1)
  })
})
