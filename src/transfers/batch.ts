import { observable, action, runInAction, computed } from "mobx";
import { FsApi, File } from "../services/Fs";
import { FileTransfer } from "./fileTransfer";
import { remote } from 'electron';
import { Deferred } from "../utils/deferred";

const MAX_TRANSFERS = 2;
const RENAME_SUFFIX = '_';


export class Batch {
    static maxId: number = 0;
    public srcFs: FsApi;
    public dstFs: FsApi;
    public dstPath: string;
    public srcPath: string;
    public id: number;
    public srcName: string;
    public dstName: string;

    @observable
    public size: number = 0;

    public files = observable<FileTransfer>([]);

    @observable
    public status: 'started' | 'queued' | 'error' | 'done' | 'calculating' = 'queued';

    @observable
    public progress: number = 0;

    public isExpanded: boolean = false;

    private transferDef: Deferred<any>;

    private slotsAvailable: number = MAX_TRANSFERS;

    private transfersDone = 0;

    constructor(srcFs: FsApi, dstFs: FsApi, srcPath: string, dstPath: string) {
        this.status = 'calculating';
        this.srcFs = srcFs;
        this.dstFs = dstFs;
        this.dstPath = dstPath;
        this.srcPath = srcPath;
        // build batch src/dst names
        this.srcName = this.getLastPathPart(srcPath);
        this.dstName = this.getLastPathPart(dstPath);
        this.id = Batch.maxId++;
    }

    @action
    updateProgress() {
        runInAction(() => {
            this.progress += .01;
            remote.getCurrentWindow().setProgressBar(this.progress);
        });
    }

    @action
    start(): Promise<void> {
        if (this.status === 'queued') {
            this.slotsAvailable = MAX_TRANSFERS;
            this.status = 'started';
            this.transferDef = new Deferred();
            this.transferDef.promise.then(() => {
                console.log('transfer ended !');
                this.status = 'done';
            }).catch((err: Error) => {
                console.log('error transfer', err);
                this.status = 'error';
                return Promise.reject(err);
            });

            this.transfersDone = 0;
            this.queueNextTransfers();
        }

        return this.transferDef.promise;
    }

    @action
    updateReadyState(subDir: string) {
        // TODO: add new filename somewhere ?
        const files = this.files.filter((file) => file.subDirectory === subDir);

        for (let transfer of files) {
            transfer.ready = true;
        }
    }

    getNextTransfer() {
        return this.files.find((file) => file.ready && file.status === 'queued');
    }

    queueNextTransfers() {
        const max = (Math.min(MAX_TRANSFERS, this.slotsAvailable));

        for (let i = 0; i < max; ++i) {
            const transfer = this.getNextTransfer();
            if (transfer) {
                this.startTransfer(transfer);
            }
        }
    }

    @action
    async startTransfer(transfer: FileTransfer) {
        this.slotsAvailable--;
        transfer.status = 'started';

        const dstFs = this.dstFs;
        const srcFs = this.srcFs;
        const fullDstPath = dstFs.join(this.dstPath, transfer.subDirectory);
        const srcPath = srcFs.join(this.srcPath, transfer.subDirectory);
        let newFilename = '';

        try {
            newFilename = await this.renameOrCreateDir(transfer, fullDstPath);
        } catch (err) {
            console.log('error creating directory', err);
            transfer.status = 'error';
        }

        if (!transfer.file.isDir) {
            try {
                console.log('getting stream', srcPath, newFilename);
                const stream = await srcFs.getStream(srcPath, newFilename);
                console.log('sending to stream', dstFs.join(fullDstPath, newFilename));
                await dstFs.putStream(stream, dstFs.join(fullDstPath, newFilename), (bytesRead: number) => {
                    console.log('read', bytesRead);
                    this.onData(transfer, bytesRead);
                });
                console.log('finished writing file', newFilename);
                transfer.status = 'done';
            } catch (err) {
                console.log('error with streams', err);
                transfer.status = 'error';
            }

        } else {
            transfer.status = 'done';
            // make transfers with this directory ready
            this.updateReadyState(srcFs.join(transfer.subDirectory, newFilename));
        }

        this.transfersDone++;
        this.slotsAvailable++;
        console.log('finished', transfer.file.fullname, 'slotsAvailable', this.slotsAvailable, 'done', this.transfersDone);
        if (this.transfersDone < this.files.length) {
            this.queueNextTransfers();
        } else {
            console.log('no more transfers !!');
            this.transferDef.resolve();
        }
    }

    async renameOrCreateDir(transfer: FileTransfer, dstPath: string): Promise<string> {
        const isDir = transfer.file.isDir;
        const dstFs = this.dstFs;
        // create directory if not exists
        const wantedName = transfer.file.fullname;
        let dirPath = dstFs.join(dstPath, wantedName);
        let newName = wantedName;
        let stats = null;
        let exists = false;
        try {
            stats = await this.dstFs.stat(dirPath);
            exists = true;
        } catch (err) {
            // TODO: handle permission denied and other errors ?
            exists = false;
        }

        let i = 1;

        // create directory if needed
        if (isDir) {
            // directory already exists: for now, simply use it
            if (!exists) {
                // TODO: handle error
                const newDir = await dstFs.makedir(dstPath, newName);
            } else if (!stats.isDir) {
                // exists but is a file: attempt to rename it
                let success = false;
                while (!success) {
                    newName = wantedName + RENAME_SUFFIX + i++;
                    try {
                        await dstFs.makedir(dstPath, newName);
                        success = true;
                    } catch (err) {
                        debugger;
                    }
                }
            }
        } else {
            while (exists) {
                newName = wantedName + RENAME_SUFFIX + i++;
                const tmpPath = dstFs.join(dstPath, newName);
                exists = await this.dstFs.exists(tmpPath);
            }
        }

        return Promise.resolve(newName);
    }

    @action
    calcTotalSize() {
        let size = 0;
        for (let fileTransfer of this.files) {
            // directory's length is the space used for dir meta data: we don't need (nor copy) that
            if (!fileTransfer.file.isDir) {
                size += fileTransfer.file.length;
            }
        }
        this.size = size;
        console.log('total transfer size', size);
    }

    getLastPathPart(path: string) {
        const parts = path.split('/');
        const lastPart = parts[parts.length - 1];
        // return `… / ${lastPart}`;
        return lastPart;
    }

    async getFileList(srcFiles: File[], subDirectory = ''):Promise<FileTransfer[]> {
        console.log('getting file list');
        const dirs = srcFiles.filter((file) => file.isDir);
        const files = srcFiles.filter((file) => !file.isDir);
        let transfers:FileTransfer[] = [];

        // add files
        for (let file of files) {
            transfers.push({
                file,
                status: 'queued',
                progress: 0,
                subDirectory,
                ready: subDirectory === ''
            });
        }

        // dir: need to call list for each directry to get files
        for (let dir of dirs) {
            transfers.push({
                file: dir,
                status: 'queued',
                progress: 0,
                subDirectory,
                ready: subDirectory === ''
            });

            // get directory listing
            const currentPath = this.srcFs.join(dir.dir, dir.fullname);
            const subFiles = await this.srcFs.list(currentPath, false);
            const subDir = this.srcFs.join(subDirectory, dir.fullname);
            transfers = transfers.concat(await this.getFileList(subFiles, subDir));
        }

        return Promise.resolve(transfers);
    }

    @action
    async setFileList(files: File[]) {
        return this.getFileList(files).then((transfers) => {
            debugger;
            // get fileStat
            this.files.replace(transfers);
        }).catch((err) => {
            return Promise.reject(err);
        });
    }

    @action
    onData(file: FileTransfer, bytesRead: number) {
        file.progress += bytesRead;
        this.progress += bytesRead;
    }
}