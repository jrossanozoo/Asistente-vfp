*-----------------------------------------------------------------------------------------
NOTE	Funcion de tres parametros. ;
		Parametros: ;
			tcA - Primero. ;
			tcB - Segundo. ;
			tcC - Tercero.
function Foo( tcA as String, tcB as String, tcC as String ) as String
	return tcA + tcB + tcC
endfunc

function Bar( a, b )
	return a + b
endfunc

function Uso
	local lcX
	lcX = Foo( a, Bar( b, c ),  )
	lcX = Foo( "x,y",  )
	lcX = Foo( 1, ;
		 )
endfunc
