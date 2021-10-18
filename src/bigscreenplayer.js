import MediaState from './models/mediastate'
import PlayerComponent from './playercomponent'
import PauseTriggers from './models/pausetriggers'
import DynamicWindowUtils from './dynamicwindowutils'
import WindowTypes from './models/windowtypes'
import MockBigscreenPlayer from './mockbigscreenplayer'
import Plugins from './plugins'
import Chronicle from './debugger/chronicle'
import DebugTool from './debugger/debugtool'
import SlidingWindowUtils from './utils/timeutils'
import callCallbacks from './utils/callcallbacks'
import MediaSources from './mediasources'
import Version from './version'
import Resizer from './resizer'
import ReadyHelper from './readyhelper'
import Subtitles from './subtitles/subtitles'

function BigscreenPlayer () {
  let stateChangeCallbacks = []
  let timeUpdateCallbacks = []
  let subtitleCallbacks = []

  let playerReadyCallback
  let playerErrorCallback
  let mediaKind
  let initialPlaybackTimeEpoch
  let serverDate
  let playerComponent
  let resizer
  let pauseTrigger
  let isSeeking = false
  let endOfStream
  let windowType
  let mediaSources
  let playbackElement
  let readyHelper
  let subtitles

  const END_OF_STREAM_TOLERANCE = 10

  function mediaStateUpdateCallback (evt) {
    if (evt.timeUpdate) {
      DebugTool.time(evt.data.currentTime)
      callCallbacks(timeUpdateCallbacks, {
        currentTime: evt.data.currentTime,
        endOfStream: endOfStream
      })
    } else {
      let stateObject = {state: evt.data.state}

      if (evt.data.state === MediaState.PAUSED) {
        endOfStream = false
        stateObject.trigger = pauseTrigger || PauseTriggers.DEVICE
        pauseTrigger = undefined
      }

      if (evt.data.state === MediaState.FATAL_ERROR) {
        stateObject = {
          state: MediaState.FATAL_ERROR,
          isBufferingTimeoutError: evt.isBufferingTimeoutError
        }
      }

      if (evt.data.state === MediaState.WAITING) {
        stateObject.isSeeking = isSeeking
        isSeeking = false
      }

      stateObject.endOfStream = endOfStream
      DebugTool.event(stateObject)

      callCallbacks(stateChangeCallbacks, stateObject)
    }

    if (evt.data.seekableRange) {
      DebugTool.keyValue({key: 'seekableRangeStart', value: deviceTimeToDate(evt.data.seekableRange.start)})
      DebugTool.keyValue({key: 'seekableRangeEnd', value: deviceTimeToDate(evt.data.seekableRange.end)})
    }

    if (evt.data.duration) {
      DebugTool.keyValue({key: 'duration', value: evt.data.duration})
    }

    if (playerComponent && readyHelper) {
      readyHelper.callbackWhenReady(evt)
    }
  }

  function deviceTimeToDate (time) {
    if (getWindowStartTime()) {
      return new Date(convertVideoTimeSecondsToEpochMs(time))
    } else {
      return new Date(time * 1000)
    }
  }

  function convertVideoTimeSecondsToEpochMs (seconds) {
    return getWindowStartTime() ? getWindowStartTime() + (seconds * 1000) : undefined
  }

  function bigscreenPlayerDataLoaded (bigscreenPlayerData, enableSubtitles) {
    if (windowType !== WindowTypes.STATIC) {
      bigscreenPlayerData.time = mediaSources.time()
      serverDate = bigscreenPlayerData.serverDate

      initialPlaybackTimeEpoch = bigscreenPlayerData.initialPlaybackTime
      // overwrite initialPlaybackTime with video time (it comes in as epoch time for a sliding/growing window)
      bigscreenPlayerData.initialPlaybackTime = SlidingWindowUtils.convertToSeekableVideoTime(bigscreenPlayerData.initialPlaybackTime, bigscreenPlayerData.time.windowStartTime)
    }

    mediaKind = bigscreenPlayerData.media.kind
    endOfStream = windowType !== WindowTypes.STATIC && (!bigscreenPlayerData.initialPlaybackTime && bigscreenPlayerData.initialPlaybackTime !== 0)

    readyHelper = new ReadyHelper(
      bigscreenPlayerData.initialPlaybackTime,
      windowType,
      PlayerComponent.getLiveSupport(),
      playerReadyCallback
    )

    playerComponent = new PlayerComponent(
      playbackElement,
      bigscreenPlayerData,
      mediaSources,
      windowType,
      mediaStateUpdateCallback,
      playerErrorCallback
    )

    subtitles = Subtitles(
      playerComponent,
      enableSubtitles,
      playbackElement,
      bigscreenPlayerData.media.subtitleCustomisation,
      mediaSources,
      callSubtitlesCallbacks
    )
  }

  function getWindowStartTime () {
    return mediaSources && mediaSources.time().windowStartTime
  }

  function getWindowEndTime () {
    return mediaSources && mediaSources.time().windowEndTime
  }

  function toggleDebug () {
    if (playerComponent) {
      DebugTool.toggleVisibility()
    }
  }

  function callSubtitlesCallbacks (enabled) {
    callCallbacks(subtitleCallbacks, { enabled: enabled })
  }

  function setSubtitlesEnabled (enabled) {
    enabled ? subtitles.enable() : subtitles.disable()
    callSubtitlesCallbacks(enabled)

    if (!resizer.isResized()) {
      enabled ? subtitles.show() : subtitles.hide()
    }
  }

  function isSubtitlesEnabled () {
    return subtitles ? subtitles.enabled() : false
  }

  function isSubtitlesAvailable () {
    return subtitles ? subtitles.available() : false
  }

  return {
    init: (newPlaybackElement, bigscreenPlayerData, newWindowType, enableSubtitles, callbacks) => {
      playbackElement = newPlaybackElement
      Chronicle.init()
      resizer = Resizer()
      DebugTool.setRootElement(playbackElement)
      DebugTool.keyValue({key: 'framework-version', value: Version})
      windowType = newWindowType
      serverDate = bigscreenPlayerData.serverDate
      if (!callbacks) {
        callbacks = {}
      }

      playerReadyCallback = callbacks.onSuccess
      playerErrorCallback = callbacks.onError

      const mediaSourceCallbacks = {
        onSuccess: () => bigscreenPlayerDataLoaded(bigscreenPlayerData, enableSubtitles),
        onError: (error) => {
          if (callbacks.onError) {
            callbacks.onError(error)
          }
        }
      }

      mediaSources = MediaSources()

      // Backwards compatibility with Old API; to be removed on Major Version Update
      if (bigscreenPlayerData.media && !bigscreenPlayerData.media.captions && bigscreenPlayerData.media.captionsUrl) {
        bigscreenPlayerData.media.captions = [{
          url: bigscreenPlayerData.media.captionsUrl
        }]
      }

      mediaSources.init(bigscreenPlayerData.media, serverDate, windowType, getLiveSupport(), mediaSourceCallbacks)
    },

    tearDown: function () {
      if (subtitles) {
        subtitles.tearDown()
        subtitles = undefined
      }

      if (playerComponent) {
        playerComponent.tearDown()
        playerComponent = undefined
      }

      if (mediaSources) {
        mediaSources.tearDown()
        mediaSources = undefined
      }

      stateChangeCallbacks = []
      timeUpdateCallbacks = []
      subtitleCallbacks = []
      endOfStream = undefined
      mediaKind = undefined
      pauseTrigger = undefined
      windowType = undefined
      resizer = undefined
      this.unregisterPlugin()
      DebugTool.tearDown()
      Chronicle.tearDown()
    },

    registerForStateChanges: (callback) => {
      stateChangeCallbacks.push(callback)
      return callback
    },

    unregisterForStateChanges: (callback) => {
      const indexOf = stateChangeCallbacks.indexOf(callback)
      if (indexOf !== -1) {
        stateChangeCallbacks.splice(indexOf, 1)
      }
    },

    registerForTimeUpdates: (callback) => {
      timeUpdateCallbacks.push(callback)
      return callback
    },

    unregisterForTimeUpdates: (callback) => {
      const indexOf = timeUpdateCallbacks.indexOf(callback)

      if (indexOf !== -1) {
        timeUpdateCallbacks.splice(indexOf, 1)
      }
    },

    registerForSubtitleChanges: (callback) => {
      subtitleCallbacks.push(callback)
      return callback
    },

    unregisterForSubtitleChanges: (callback) => {
      const indexOf = subtitleCallbacks.indexOf(callback)
      if (indexOf !== -1) {
        subtitleCallbacks.splice(indexOf, 1)
      }
    },

    setCurrentTime: function (time) {
      DebugTool.apicall('setCurrentTime')
      if (playerComponent) {
        // this flag must be set before calling into playerComponent.setCurrentTime - as this synchronously fires a WAITING event (when native strategy).
        isSeeking = true
        playerComponent.setCurrentTime(time)
        endOfStream = windowType !== WindowTypes.STATIC && Math.abs(this.getSeekableRange().end - time) < END_OF_STREAM_TOLERANCE
      }
    },

    setPlaybackRate: (rate) => {
      if (playerComponent) {
        playerComponent.setPlaybackRate(rate)
      }
    },

    getPlaybackRate: () => playerComponent && playerComponent.getPlaybackRate(),
    getCurrentTime: () => playerComponent && playerComponent.getCurrentTime() || 0,
    getMediaKind: () => mediaKind,
    getWindowType: () => windowType,
    getSeekableRange: () => playerComponent ? playerComponent.getSeekableRange() : {},

    isPlayingAtLiveEdge: function () {
      return !!playerComponent && windowType !== WindowTypes.STATIC && Math.abs(this.getSeekableRange().end - this.getCurrentTime()) < END_OF_STREAM_TOLERANCE
    },

    getLiveWindowData: () => {
      if (windowType === WindowTypes.STATIC) {
        return {}
      }

      return {
        windowStartTime: getWindowStartTime(),
        windowEndTime: getWindowEndTime(),
        initialPlaybackTime: initialPlaybackTimeEpoch,
        serverDate: serverDate
      }
    },

    getDuration: () => playerComponent && playerComponent.getDuration(),
    isPaused: () => playerComponent ? playerComponent.isPaused() : true,
    isEnded: () => playerComponent ? playerComponent.isEnded() : false,

    play: () => {
      DebugTool.apicall('play')
      playerComponent.play()
    },

    pause: (opts) => {
      DebugTool.apicall('pause')
      pauseTrigger = opts && opts.userPause === false ? PauseTriggers.APP : PauseTriggers.USER
      playerComponent.pause(opts)
    },

    resize: (top, left, width, height, zIndex) => {
      subtitles.hide()
      resizer.resize(playbackElement, top, left, width, height, zIndex)
    },

    clearResize: () => {
      if (subtitles.enabled()) {
        subtitles.show()
      } else {
        subtitles.hide()
      }
      resizer.clear(playbackElement)
    },

    setSubtitlesEnabled: setSubtitlesEnabled,
    isSubtitlesEnabled: isSubtitlesEnabled,
    isSubtitlesAvailable: isSubtitlesAvailable,

    areSubtitlesCustomisable: () => {
      return !(window.bigscreenPlayer && window.bigscreenPlayer.overrides && window.bigscreenPlayer.overrides.legacySubtitles)
    },

    customiseSubtitles: (styleOpts) => {
      if (subtitles) {
        subtitles.customise(styleOpts)
      }
    },

    renderSubtitleExample: (xmlString, styleOpts, safePosition) => {
      if (subtitles) {
        subtitles.renderExample(xmlString, styleOpts, safePosition)
      }
    },

    clearSubtitleExample: () => {
      if (subtitles) {
        subtitles.clearExample()
      }
    },

    setTransportControlsPosition: (position) => {
      if (subtitles) {
        subtitles.setPosition(position)
      }
    },

    canSeek: function () {
      return windowType === WindowTypes.STATIC || DynamicWindowUtils.canSeek(getWindowStartTime(), getWindowEndTime(), getLiveSupport(), this.getSeekableRange())
    },

    canPause: () => {
      return windowType === WindowTypes.STATIC || DynamicWindowUtils.canPause(getWindowStartTime(), getWindowEndTime(), getLiveSupport())
    },

    mock: function (opts) { MockBigscreenPlayer.mock(this, opts) },
    unmock: function () { MockBigscreenPlayer.unmock(this) },
    mockJasmine: function (opts) { MockBigscreenPlayer.mockJasmine(this, opts) },

    registerPlugin: (plugin) => Plugins.registerPlugin(plugin),
    unregisterPlugin: (plugin) => Plugins.unregisterPlugin(plugin),
    transitions: () => playerComponent ? playerComponent.transitions() : {},
    getPlayerElement: () => playerComponent && playerComponent.getPlayerElement(),

    convertEpochMsToVideoTimeSeconds: (epochTime) => {
      return getWindowStartTime() ? Math.floor((epochTime - getWindowStartTime()) / 1000) : undefined
    },

    getFrameworkVersion: () => {
      return Version
    },

    convertVideoTimeSecondsToEpochMs: convertVideoTimeSecondsToEpochMs,
    toggleDebug: toggleDebug,
    getLogLevels: () => DebugTool.logLevels,
    setLogLevel: DebugTool.setLogLevel,
    getDebugLogs: () => Chronicle.retrieve()
  }
}

function getLiveSupport () {
  return PlayerComponent.getLiveSupport()
}

BigscreenPlayer.getLiveSupport = getLiveSupport

BigscreenPlayer.version = Version

export default BigscreenPlayer