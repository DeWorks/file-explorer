import { platform } from 'process';
import { release } from 'os';
import { remote, app } from 'electron';

declare var ENV: any;

const appInstance = app || remote.app;
export const isMac = platform === 'darwin';
export const isMojave = isMac && ((parseInt(release().split('.')[0], 10) - 4) >= 14);
export const isWin = platform === 'win32';
export const defaultFolder = ENV.NODE_ENV === 'production' ? appInstance.getPath('home') : (platform === "win32" ? appInstance.getPath('temp') : '/tmp/react-explorer');