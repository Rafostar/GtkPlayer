const { GLib, GObject, Gtk, Gst, GstPlayer } = imports.gi;
const { Controls } = imports.clapper_src.controls;
const Debug = imports.clapper_src.debug;

let { debug } = Debug;

var Interface = GObject.registerClass(
class ClapperInterface extends Gtk.Grid
{
    _init(opts)
    {
        Debug.gstVersionCheck();

        super._init();

        let defaults = {
            seekOnDrop: true
        };
        Object.assign(this, defaults, opts);

        this.controlsInVideo = false;
        this.lastVolumeValue = null;
        this.lastPositionValue = 0;
        this.needsTracksUpdate = true;
        this.revealTime = 800;
        this.headerBar = null;
        this.defaultTitle = null;

        this.overlay = new Gtk.Overlay();
        this.controls = new Controls();
        this.revealer = new Gtk.Revealer({
            transition_duration: this.revealTime,
            transition_type: Gtk.RevealerTransitionType.SLIDE_UP,
            valign: Gtk.Align.END,
        });
        this.revealerBox = new Gtk.Box();
        let revealerContext = this.revealerBox.get_style_context();
        revealerContext.add_class('osd');

        this.revealer.add(this.revealerBox);
        this.attach(this.overlay, 0, 0, 1, 1);
        this.attach(this.controls, 0, 1, 1, 1);
    }

    addPlayer(player)
    {
        this._player = player;
        this._player.widget.expand = true;

        this._player.connect('state-changed', this._onPlayerStateChanged.bind(this));
        this._player.connect('volume-changed', this._onPlayerVolumeChanged.bind(this));
        this._player.connect('duration-changed', this._onPlayerDurationChanged.bind(this));
        this._player.connect('position-updated', this._onPlayerPositionUpdated.bind(this));

        this.controls.togglePlayButton.connect(
            'clicked', this._onControlsTogglePlayClicked.bind(this)
        );
        this.controls.positionScale.connect(
            'value-changed', this._onControlsPositionChanged.bind(this)
        );
        this.controls.volumeScale.connect(
            'value-changed', this._onControlsVolumeChanged.bind(this)
        );
        this.controls.connect(
            'position-seeking-changed', this._onPositionSeekingChanged.bind(this)
        );
        this.controls.connect(
            'track-change-requested', this._onTrackChangeRequested.bind(this)
        );

        this.overlay.add(this._player.widget);
    }

    addHeaderBar(headerBar, defaultTitle)
    {
        this.headerBar = headerBar;
        this.defaultTitle = defaultTitle || null;
    }

    revealControls(isReveal)
    {
        this.revealer.set_transition_duration(this.revealTime);
        this.revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_UP);
        this.revealer.set_reveal_child(isReveal);
    }

    showControls(isShow)
    {
        this.revealer.set_transition_duration(0);
        this.revealer.set_transition_type(Gtk.RevealerTransitionType.NONE);
        this.revealer.set_reveal_child(isShow);
    }

    setControlsOnVideo(isOnVideo)
    {
        if(this.controlsInVideo === isOnVideo)
            return;

        if(isOnVideo) {
            this.remove(this.controls);
            this.controls.pack_start(this.controls.unfullscreenButton, false, false, 0);
            this.overlay.add_overlay(this.revealer);
            this.revealerBox.pack_start(this.controls, false, true, 0);
            this.revealer.show();
            this.revealerBox.show();
        }
        else {
            this.revealerBox.remove(this.controls);
            this.controls.remove(this.controls.unfullscreenButton);
            this.overlay.remove(this.revealer);
            this.attach(this.controls, 0, 1, 1, 1);
            this.controls.show();
        }

        this.controlsInVideo = isOnVideo;
        debug(`placed controls in overlay: ${isOnVideo}`);
    }

    updateMediaTracks()
    {
        let mediaInfo = this._player.get_media_info();

        // set titlebar media title and path
        this.updateHeaderBar(mediaInfo);

        // we can also check if video is "live" or "seekable" (right now unused)
        // it might be a good idea to hide position seek bar and disable seeking
        // when playing not seekable media (not implemented yet)
        //let isLive = mediaInfo.is_live();
        //let isSeekable = mediaInfo.is_seekable();

        let streamList = mediaInfo.get_stream_list();
        let parsedInfo = {
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: []
        };

        for(let info of streamList) {
            let type, text;

            switch(info.constructor) {
                case GstPlayer.PlayerVideoInfo:
                    type = 'video';
                    let fps = info.get_framerate();
                    text = info.get_codec() + ', ' +
                        + info.get_width() + 'x'
                        + info.get_height() + '@'
                        + Number((fps[0] / fps[1]).toFixed(2));
                    break;
                case GstPlayer.PlayerAudioInfo:
                    type = 'audio';
                    let codec = info.get_codec();
                    // This one is too long to fit nicely in UI
                    if(codec.startsWith('Free Lossless Audio Codec'))
                        codec = 'FLAC';
                    text = info.get_language() || 'Unknown';
                    text += ', ' + codec + ', '
                        + info.get_channels() + ' Channels';
                    break;
                case GstPlayer.PlayerSubtitleInfo:
                    type = 'subtitle';
                    text = info.get_language() || 'Unknown';
                    break;
                default:
                    debug(`unrecognized media info type: ${info.constructor}`);
                    break;
            }
            let tracksArr = parsedInfo[`${type}Tracks`];
            if(!tracksArr.length)
            {
                tracksArr[0] = {
                    label: 'Disabled',
                    type: type,
                    value: -1
                };
            }
            tracksArr.push({
                label: text,
                type: type,
                value: info.get_index(),
            });
        }

        for(let type of ['video', 'audio', 'subtitle']) {
            let currStream = this._player[`get_current_${type}_track`]();
            let activeId = (currStream) ? currStream.get_index() : -1;

            if(currStream && type !== 'subtitle') {
                let caps = currStream.get_caps();
                debug(`${type} caps: ${caps.to_string()}`, 'LEVEL_INFO');
            }
            this.controls.addRadioButtons(
                this.controls[`${type}TracksButton`].popoverBox,
                parsedInfo[`${type}Tracks`],
                activeId
            );
        }
    }

    updateHeaderBar(mediaInfo)
    {
        if(!this.headerBar)
            return;

        let title = mediaInfo.get_title();
        let subtitle = mediaInfo.get_uri() || null;

        if(subtitle.startsWith('file://')) {
            subtitle = GLib.filename_from_uri(subtitle)[0];
            subtitle = GLib.path_get_basename(subtitle);
        }

        if(!title) {
            title = (!subtitle)
                ? this.defaultTitle
                : (subtitle.includes('.'))
                ? subtitle.split('.').slice(0, -1).join('.')
                : subtitle;

            subtitle = null;
        }

        this.headerBar.set_title(title);
        this.headerBar.set_subtitle(subtitle);
    }

    _onTrackChangeRequested(self, trackType, trackId)
    {
        // reenabling audio is slow (as expected),
        // so it is better to toggle mute instead
        if(trackType === 'audio') {
            if(trackId < 0)
                return this._player.set_mute(true);

            if(this._player.get_mute())
                this._player.set_mute(false);

            return this._player[`set_${trackType}_track`](trackId);
        }

        if(trackId < 0) {
            // disabling video leaves last frame frozen,
            // so we also hide the widget
            if(trackType === 'video')
                this._player.widget.hide();

            return this._player[`set_${trackType}_track_enabled`](false);
        }

        this._player[`set_${trackType}_track`](trackId);
        this._player[`set_${trackType}_track_enabled`](true);

        if(trackType === 'video' && !this._player.widget.get_visible()) {
            this._player.widget.show();
            this._player.renderer.expose();
        }
    }

    _onPlayerStateChanged(player, state)
    {
        switch(state) {
            case GstPlayer.PlayerState.BUFFERING:
                break;
            case GstPlayer.PlayerState.STOPPED:
                this.needsTracksUpdate = true;
            case GstPlayer.PlayerState.PAUSED:
                this.controls.togglePlayButton.setPlayImage();
                break;
            case GstPlayer.PlayerState.PLAYING:
                this.controls.togglePlayButton.setPauseImage();
                if(this.needsTracksUpdate) {
                    this.needsTracksUpdate = false;
                    this.updateMediaTracks();
                }
                break;
            default:
                break;
        }
    }

    _onPlayerDurationChanged(player)
    {
        let duration = player.get_duration() / 1000000000;
        let increment = (duration < 1)
            ? 0
            : (duration < 100)
            ? 1
            : duration / 100;

        this.controls.positionAdjustment.set_upper(duration);
        this.controls.positionAdjustment.set_step_increment(increment);
        this.controls.positionAdjustment.set_page_increment(increment);

        this.controls.durationFormated = this.controls._getFormatedTime(duration);
    }

    _onPlayerPositionUpdated(player, position)
    {
        if(
            this.controls.isPositionSeeking
            || this._player.state === GstPlayer.PlayerState.BUFFERING
        )
            return;

        let positionSeconds = Math.round(position / 1000000000);

        if(positionSeconds === this.lastPositionValue)
            return;

        this.lastPositionValue = positionSeconds;
        this.controls.positionScale.set_value(positionSeconds);
    }

    _onPlayerVolumeChanged()
    {
        let volume = Number(this._player.get_volume().toFixed(2));

        if(volume === this.lastVolumeValue)
            return;

        this.lastVolumeValue = volume;
        this.controls.volumeScale.set_value(volume);
    }

    _onPositionSeekingChanged(self, isPositionSeeking)
    {
        if(isPositionSeeking || !this.seekOnDrop)
            return;

        this._onControlsPositionChanged(this.controls.positionScale);
    }

    _onControlsTogglePlayClicked()
    {
        this._player.toggle_play();
    }

    _onControlsPositionChanged(positionScale)
    {
        if(this.seekOnDrop && this.controls.isPositionSeeking)
            return;

        let positionSeconds = Math.round(positionScale.get_value());

        if(positionSeconds === this.lastPositionValue)
            return;

        this.lastPositionValue = positionSeconds;
        this._player.seek_seconds(positionSeconds);
    }

    _onControlsVolumeChanged(volumeScale)
    {
        let volume = Number(volumeScale.get_value().toFixed(2));

        let icon = (volume <= 0)
            ? 'muted'
            : (volume <= 0.33)
            ? 'low'
            : (volume <= 0.66)
            ? 'medium'
            : (volume <= 1)
            ? 'high'
            : 'overamplified';

        let iconName = `audio-volume-${icon}-symbolic`;

        if(this.controls.volumeButton.image.icon_name !== iconName)
        {
            debug(`set volume icon: ${icon}`);
            this.controls.volumeButton.image.set_from_icon_name(
                iconName,
                this.controls.volumeButton.image.icon_size
            );
        }

        if(volume === this.lastVolumeValue)
            return;

        this.lastVolumeValue = volume;
        this._player.set_volume(volume);
    }
});
