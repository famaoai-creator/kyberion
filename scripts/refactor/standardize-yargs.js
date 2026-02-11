/**
 * jscodeshift Transform: Standardize Yargs usage
 * Replaces manual yargs setup with createStandardYargs()
 */
module.exports = function(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1. Remove legacy yargs requires
  root.find(j.VariableDeclaration).filter(path => {
    const decl = path.node.declarations[0];
    return decl.init && decl.init.type === 'CallExpression' && 
           (decl.init.callee.name === 'require' && 
            (decl.init.arguments[0].value === 'yargs/yargs' || decl.init.arguments[0].value === 'yargs/helpers'));
  }).remove();

  // 2. Replace manual initialization with createStandardYargs()
  // Pattern: const argv = yargs(hideBin(process.argv))...
  root.find(j.VariableDeclarator).filter(path => {
    return path.node.id.name === 'argv' && 
           path.node.init && 
           path.node.init.type === 'CallExpression' && 
           path.node.init.callee.name === 'yargs';
  }).forEach(path => {
    path.node.init = j.callExpression(j.identifier('createStandardYargs'), []);
  });

  return root.toSource();
};
