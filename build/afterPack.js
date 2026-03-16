const { execSync } = require('child_process');
const path = require('path');

exports.default = async function(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`Cleaning app bundle: ${appPath}`);

  try {
    // Use ditto to copy without resource forks, then replace
    const tmpPath = `/tmp/ClaudeMC_clean_${Date.now()}`;

    // Copy without preserving resource forks
    execSync(`ditto --norsrc "${appPath}" "${tmpPath}"`, { stdio: 'inherit' });

    // Remove original
    execSync(`rm -rf "${appPath}"`, { stdio: 'inherit' });

    // Move clean copy back
    execSync(`mv "${tmpPath}" "${appPath}"`, { stdio: 'inherit' });

    // Also xattr just to be sure
    execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });

    console.log('App bundle cleaned successfully');
  } catch (error) {
    console.error('Error during cleanup:', error.message);
    throw error;
  }
};
