import { FsApi, File } from './Fs';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import * as mkdir from 'mkdirp';
import * as del from 'del';
import * as cp from 'cpy';
import { size } from '../utils/size';

const isWin = process.platform === "win32";
const invalidChars = isWin && /[\*:<>\?|"]+/ig || /^[\.]+[\/]+(.)*$/ig;
const localStart = isWin && /^(([a-zA-Z]\:)|(\/|\.))/ || /^(\/|\.)/;

const Parent: File = {
    dir: '..',
    fullname: '..',
    name: '',
    extension: '',
    cDate: new Date(),
    mDate: new Date(),
    length: 0,
    mode: 0,
    isDir: true,
    readonly: true
};

class LocalApi implements FsApi {
    type = 0;
    // current path
    path: string;

    constructor(path:string) {
        this.path = this.resolve(path);
    }

    // local fs doesn't require login
    isConnected():boolean {
        return true;
    }

    isDirectoryNameValid(dirName: string): boolean {
        return !!!dirName.match(invalidChars);
    }

    join(...paths: string[]): string {
        return path.join(...paths);
    }

    resolve(newPath: string): string {
        return path.resolve(newPath);
    }

    // TODO: attempts to read the directory, maybe it's not accessible
    cd(path: string) {
        const resolved = this.resolve(path);
        console.warn('TODO: Local.cd', path, resolved);

        return Promise.resolve(resolved);
    }

    size(source: string, files: string[]): Promise<number> {
        return new Promise(async (resolve, reject) => {
            try {
                let bytes = 0;
                for (let file of files) {
                    bytes += await size(path.join(source, file));
                }
                resolve(bytes);
            } catch (err) {
                reject(err);
            }
        });
    }

    copy(source: string, files: string[], dest: string): Promise<any> & cp.ProgressEmitter {
        console.log('***', files, dest, source);
        return cp(files, dest, { parents: true, cwd: source });
    }

    makedir(source: string, dirName: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const unixPath = path.join(source, dirName).replace(/\\/g, '/');
            try {
                console.log('mkdir', unixPath);
                mkdir(unixPath, (err) => {
                    if (err) {
                        reject(false);
                    } else {
                        resolve(path.join(source, dirName));
                    }
                });

            } catch (err) {
                console.error(err);
                reject(false);
            }
        });
    }

    delete(source:string, files: File[]): Promise<number> {
        let toDelete = files.map((file) => path.join(source, file.fullname));

        return new Promise(async (resolve, reject) => {
            try {
                console.log('delete', toDelete);
                await del(toDelete);
                resolve(files.length);
            } catch (err) {
                reject(err);
            }
        });
    }

    rename(source:string, file: File, newName: string): Promise <string> {
        const oldPath = path.join(source, file.fullname);
        const newPath = path.join(source, newName);

        if (!newName.match(invalidChars)) {
            console.log('valid !', oldPath, newPath);
            return new Promise((resolve, reject) => {
                fs.rename(oldPath, newPath, (err) => {
                    if (err) {
                        reject(file.fullname);
                    } else {
                        resolve(newName);
                    }
                });
            });
        }
        // reject promise with previous name in case of invalid chars
        return Promise.reject(file.fullname);
    }

    exists(path: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            try {
                const stat = fs.statSync(path);
                resolve(stat.isDirectory());
            } catch (err) {
                reject(err);
            }
        });
    }

    async list(/*source:string, */dir: string): Promise<File[]> {
        console.log('calling readDirectory', dir);
        const pathExists = await this.exists(dir);

        if (pathExists) {
            return new Promise<File[]>((resolve, reject) => {
                fs.readdir(dir, (err, items) => {
                    if (err) {
                        reject(`Could not read directory '${path}', reason: ${err}`);
                    } else {
                        const dirPath = path.resolve(dir);

                        const files: File[] = [];

                        for (var i = 0; i < items.length; i++) {
                            const fullPath = path.join(dirPath, items[i]);
                            const format = path.parse(fullPath);
                            const stats = fs.statSync(path.join(dirPath, items[i]));

                            const file =
                            {
                                dir: format.dir,
                                fullname: items[i],
                                name: format.name,
                                extension: format.ext,
                                cDate: stats.ctime,
                                mDate: stats.mtime,
                                length: stats.size,
                                mode: stats.mode,
                                isDir: stats.isDirectory(),
                                readonly: false
                            };

                            files.push(file);
                        }

                        // add parent
                        const parent = { ...Parent, dir: dirPath };

                        // TODO: detect root directory and only append parent if not root
                        resolve([parent].concat(files));
                    }
                });
            });
        } else {
            return Promise.reject('Path does not exist');
        }
    }
};

export const FsLocal = {
    name: 'local',
    description: 'Local Filesystem',
    canread(str: string): boolean {
        return !!str.match(localStart);
    },
    serverpart(str: string): string {
        const server = str.replace(/^ftp\:\/\//, '');
        return server.split('/')[0];
    },
    API: LocalApi
}