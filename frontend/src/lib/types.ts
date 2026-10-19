// バックエンドとやりとりする形。smoke で固定されているものに合わせてある。

export type Song = {
  id?: string;
  title: string;
  artist?: string;
};

export type NowPlaying = {
  title: string;
  artist?: string;
  key?: string;
  seq?: number;
};

export type QueueItem = {
  id: string;
  songId?: string | null;
  title: string;
  artist?: string;
  key?: string;
  note?: string;
};

export type QueueState = {
  items: QueueItem[];
  /** ★ 並び替えのときに必ず送り返す。古い rev を送ると 409 で弾かれる */
  rev: number;
};

export type SungResult = {
  sung: {
    songId: string | null;
    title: string;
    artist?: string;
    key?: string;
  };
};

export type RepertoireInput = {
  songId?: string;
  title: string;
  artist?: string;
  key?: string;
  note?: string;
};

export type PerformanceInput = {
  songId?: string | null;
  title?: string;
  artist?: string;
  key?: string;
  note?: string;
  /** ★ 冪等キー。**積むときに 1 回だけ作って、再送でも変えない** */
  clientId: string;
};
