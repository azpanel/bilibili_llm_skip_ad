# 持久协作约束

- B 站字幕检测必须区分播放器就绪与字幕可用性：`.bpx-player-ctrl-playbackrate-result` 仅表示播放器加载完成；加载完成后，只有 `.bpx-player-ctrl-subtitle-result` 存在才请求官方字幕，否则直接按无字幕处理。不要把倍速控件存在解释为应无条件请求字幕。