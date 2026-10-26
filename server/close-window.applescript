-- 이름에 주어진 글(.command 파일 이름)이 든 터미널 창을 닫는다. 그 창에서 아직 무언가 돌고 있으면 닫지 않는다
-- (돌고 있을 때 닫으면 "실행 중인 프로세스를 끝낼까요?"를 묻는다). 다 닫았으면 "gone"을 돌려준다.
on run argv
	set target to item 1 of argv
	tell application "Terminal"
		set ids to id of (every window whose name contains target)
		if (count of ids) is 0 then return "gone"
		repeat with i in ids
			set b to false
			try
				set b to busy of selected tab of window id i
			end try
			if b is not true then close window id i
		end repeat
	end tell
	return "tried"
end run
